//! Language-agnostic symbol and edge extraction over tree-sitter grammars.
//!
//! This is the non-JavaScript half of the retrieval index. TypeScript and
//! JavaScript are extracted in-process by the TypeScript compiler API, which
//! resolves bindings and therefore produces better reference edges than a syntax
//! tree can. Everything else used to fall back to a per-line regex that could
//! only report "a line that looks like a definition": single-line spans, no call
//! graph, no scoping.
//!
//! The output shape deliberately matches what the TypeScript extractor emits, so
//! the index, the ranking, and the slice reader do not need to know which
//! extractor produced a row.

use serde::Serialize;
use tree_sitter::{Language, Node, Parser};

#[derive(Debug, Serialize)]
pub struct ExtractedSymbol {
    pub name: String,
    pub kind: String,
    #[serde(rename = "startLine")]
    pub start_line: u32,
    #[serde(rename = "endLine")]
    pub end_line: u32,
    pub exported: bool,
    pub signature: String,
}

#[derive(Debug, Serialize)]
pub struct ExtractedEdge {
    pub kind: String,
    #[serde(rename = "sourceSymbol", skip_serializing_if = "Option::is_none")]
    pub source_symbol: Option<String>,
    #[serde(rename = "targetName")]
    pub target_name: String,
    pub line: u32,
    #[serde(rename = "moduleSpecifier", skip_serializing_if = "Option::is_none")]
    pub module_specifier: Option<String>,
}

#[derive(Debug, Serialize, Default)]
pub struct ExtractedFile {
    pub symbols: Vec<ExtractedSymbol>,
    pub edges: Vec<ExtractedEdge>,
    /// The grammar that produced this, or `null` when none matched.
    pub language: Option<String>,
}

/// Grammar for a file extension, or `None` when the caller should fall back.
pub fn language_for(ext: &str) -> Option<(Language, &'static str)> {
    match ext {
        "ts" | "mts" | "cts" => {
            Some((tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(), "typescript"))
        }
        "tsx" => Some((tree_sitter_typescript::LANGUAGE_TSX.into(), "tsx")),
        "js" | "mjs" | "cjs" | "jsx" => {
            Some((tree_sitter_javascript::LANGUAGE.into(), "javascript"))
        }
        "py" | "pyi" => Some((tree_sitter_python::LANGUAGE.into(), "python")),
        "rs" => Some((tree_sitter_rust::LANGUAGE.into(), "rust")),
        "go" => Some((tree_sitter_go::LANGUAGE.into(), "go")),
        "c" | "h" => Some((tree_sitter_c::LANGUAGE.into(), "c")),
        "cc" | "cpp" | "cxx" | "hpp" | "hh" | "hxx" => {
            Some((tree_sitter_cpp::LANGUAGE.into(), "cpp"))
        }
        _ => None,
    }
}

/// Node kinds that declare something worth indexing, per grammar family.
///
/// Keyed on tree-sitter node kinds rather than on language, because the
/// grammars share most names: `function_definition` covers Python, C, and C++,
/// and `type_declaration` covers Go and Rust-adjacent shapes.
fn declaration_kind(kind: &str) -> Option<&'static str> {
    Some(match kind {
        "function_declaration" | "function_definition" | "function_item" => "function",
        "method_declaration" | "method_definition" | "method_spec" => "method",
        "class_declaration" | "class_definition" | "class_specifier" => "class",
        "struct_item" | "struct_specifier" => "struct",
        "enum_item" | "enum_specifier" | "enum_declaration" => "enum",
        "union_specifier" => "union",
        "interface_declaration" => "interface",
        "trait_item" => "trait",
        "impl_item" => "impl",
        "mod_item" | "namespace_definition" => "module",
        "type_declaration" | "type_alias_declaration" | "type_item" | "type_definition" => "type",
        "const_item" | "static_item" => "constant",
        "type_spec" => "type",
        "decorated_definition" => return None,
        _ => return None,
    })
}

/// Extract symbols and edges from one source file.
pub fn extract(code: &str, ext: &str) -> ExtractedFile {
    let Some((language, label)) = language_for(ext) else {
        return ExtractedFile::default();
    };
    let mut parser = Parser::new();
    if parser.set_language(&language).is_err() {
        return ExtractedFile::default();
    }
    let Some(tree) = parser.parse(code, None) else {
        return ExtractedFile::default();
    };

    let bytes = code.as_bytes();
    let mut file = ExtractedFile {
        language: Some(label.to_string()),
        ..ExtractedFile::default()
    };
    walk(tree.root_node(), bytes, None, &mut file);
    dedupe_edges(&mut file);
    file
}

/// Depth-first walk carrying the nearest enclosing declaration.
///
/// The enclosing name is what turns a flat list of call sites into a graph: a
/// `call` edge is only useful if it records *which* function performs it.
fn walk(node: Node, bytes: &[u8], enclosing: Option<&str>, file: &mut ExtractedFile) {
    let mut current_owner = enclosing.map(|value| value.to_string());

    if let Some(kind) = declaration_kind(node.kind()) {
        if let Some(name) = declared_name(node, bytes) {
            let start_line = node.start_position().row as u32 + 1;
            let end_line = node.end_position().row as u32 + 1;
            file.symbols.push(ExtractedSymbol {
                name: name.clone(),
                kind: kind.to_string(),
                start_line,
                end_line,
                exported: is_exported(node, bytes, &name),
                signature: signature_of(node, bytes),
            });
            file.edges.push(ExtractedEdge {
                kind: "definition".to_string(),
                source_symbol: enclosing.map(|value| value.to_string()),
                target_name: name.clone(),
                line: start_line,
                module_specifier: None,
            });
            current_owner = Some(name);
        }
    }

    collect_edges(node, bytes, current_owner.as_deref(), file);

    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        walk(child, bytes, current_owner.as_deref(), file);
    }
}

/// Call, import, and reference edges for a single node.
fn collect_edges(node: Node, bytes: &[u8], owner: Option<&str>, file: &mut ExtractedFile) {
    let line = node.start_position().row as u32 + 1;
    match node.kind() {
        "call_expression" | "call" => {
            if let Some(name) = called_name(node, bytes) {
                file.edges.push(ExtractedEdge {
                    kind: "call".to_string(),
                    source_symbol: owner.map(|value| value.to_string()),
                    target_name: name,
                    line,
                    module_specifier: None,
                });
            }
        }
        // Python `import x` / `from x import y`, Go import specs, Rust `use`,
        // and C/C++ `#include` all land here.
        "import_statement"
        | "import_from_statement"
        | "import_spec"
        | "use_declaration"
        | "preproc_include" => {
            if let Some(module) = imported_module(node, bytes) {
                let target = module
                    .rsplit(|c| c == '/' || c == '.' || c == ':')
                    .find(|part| !part.is_empty())
                    .unwrap_or(&module)
                    .to_string();
                file.edges.push(ExtractedEdge {
                    kind: "import".to_string(),
                    source_symbol: owner.map(|value| value.to_string()),
                    target_name: target,
                    line,
                    module_specifier: Some(module),
                });
            }
        }
        // A bare identifier that is not the declaration itself: a reference.
        // Restricted to type and field positions so a walk does not emit an
        // edge for every token in the file.
        "type_identifier" | "field_identifier" | "qualified_type" => {
            if let Ok(text) = node.utf8_text(bytes) {
                if !text.is_empty() {
                    file.edges.push(ExtractedEdge {
                        kind: "reference".to_string(),
                        source_symbol: owner.map(|value| value.to_string()),
                        target_name: text.to_string(),
                        line,
                        module_specifier: None,
                    });
                }
            }
        }
        _ => {}
    }
}

fn declared_name(node: Node, bytes: &[u8]) -> Option<String> {
    if let Some(name) = node.child_by_field_name("name") {
        if let Ok(text) = name.utf8_text(bytes) {
            return Some(text.to_string());
        }
    }
    // C and C++ bury the name inside a declarator chain.
    if let Some(declarator) = node.child_by_field_name("declarator") {
        if let Some(name) = innermost_declarator_name(declarator, bytes) {
            return Some(name);
        }
    }
    // Rust `impl Type` has no name field; index it under the type it implements.
    if node.kind() == "impl_item" {
        if let Some(type_node) = node.child_by_field_name("type") {
            if let Ok(text) = type_node.utf8_text(bytes) {
                return Some(text.to_string());
            }
        }
    }
    None
}

fn innermost_declarator_name(node: Node, bytes: &[u8]) -> Option<String> {
    let mut current = node;
    for _ in 0..8 {
        match current.kind() {
            "identifier" | "field_identifier" | "type_identifier" | "operator_name"
            | "destructor_name" | "qualified_identifier" => {
                return current.utf8_text(bytes).ok().map(|text| text.to_string());
            }
            _ => {}
        }
        match current.child_by_field_name("declarator") {
            Some(next) => current = next,
            None => break,
        }
    }
    None
}

fn called_name(node: Node, bytes: &[u8]) -> Option<String> {
    let function = node.child_by_field_name("function")?;
    let text = match function.kind() {
        // `a.b()` and `a::b()` are indexed under `b`, matching how the
        // TypeScript extractor records a property call.
        "attribute" | "field_expression" | "selector_expression" | "member_expression" => function
            .child_by_field_name("field")
            .or_else(|| function.child_by_field_name("attribute"))
            .or_else(|| function.child_by_field_name("property"))
            .or_else(|| function.child_by_field_name("name"))
            .and_then(|child| child.utf8_text(bytes).ok())
            .map(|value| value.to_string()),
        "scoped_identifier" | "qualified_identifier" => function
            .child_by_field_name("name")
            .and_then(|child| child.utf8_text(bytes).ok())
            .map(|value| value.to_string()),
        _ => function.utf8_text(bytes).ok().map(|value| value.to_string()),
    }?;
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.len() > 120 {
        return None;
    }
    Some(trimmed.to_string())
}

fn imported_module(node: Node, bytes: &[u8]) -> Option<String> {
    for field in ["source", "path", "name", "argument"] {
        if let Some(child) = node.child_by_field_name(field) {
            if let Ok(text) = child.utf8_text(bytes) {
                let cleaned = text.trim_matches(['"', '\'', '<', '>', ' '].as_slice());
                if !cleaned.is_empty() {
                    return Some(cleaned.to_string());
                }
            }
        }
    }
    // `use a::b::c;` and `#include "x.h"` expose the path as a plain child.
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        match child.kind() {
            "string_literal" | "system_lib_string" | "scoped_identifier" | "identifier"
            | "dotted_name" | "interpreted_string_literal" | "use_list" | "use_wildcard" => {
                if let Ok(text) = child.utf8_text(bytes) {
                    let cleaned = text.trim_matches(['"', '\'', '<', '>', ' '].as_slice());
                    if !cleaned.is_empty() {
                        return Some(cleaned.to_string());
                    }
                }
            }
            _ => {}
        }
    }
    None
}

/// Whether a declaration is visible outside its file.
///
/// Each language says this differently: Rust with `pub`, Go with a leading
/// capital, C/C++ by not being `static`, Python by not being underscore-prefixed.
fn is_exported(node: Node, bytes: &[u8], name: &str) -> bool {
    let text = node.utf8_text(bytes).unwrap_or("");
    let head = text.lines().next().unwrap_or("");
    if head.contains("pub ") || head.contains("export ") {
        return true;
    }
    if head.trim_start().starts_with("static ") {
        return false;
    }
    match name.chars().next() {
        // Go's capitalisation rule, which is also a reasonable default for
        // C/C++ headers and does no harm elsewhere.
        Some(first) if first.is_uppercase() => true,
        Some('_') => false,
        _ => false,
    }
}

fn signature_of(node: Node, bytes: &[u8]) -> String {
    let text = node.utf8_text(bytes).unwrap_or("");
    let head = text
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .trim_end_matches('{')
        .trim()
        .to_string();
    if head.len() > 180 {
        head.chars().take(180).collect()
    } else {
        head
    }
}

/// Drop duplicate edges so a symbol referenced many times on one line is one row.
fn dedupe_edges(file: &mut ExtractedFile) {
    let mut seen = std::collections::HashSet::new();
    file.edges.retain(|edge| {
        seen.insert((
            edge.kind.clone(),
            edge.source_symbol.clone(),
            edge.target_name.clone(),
            edge.line,
        ))
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(file: &ExtractedFile) -> Vec<&str> {
        file.symbols.iter().map(|s| s.name.as_str()).collect()
    }

    fn calls(file: &ExtractedFile) -> Vec<(&str, &str)> {
        file.edges
            .iter()
            .filter(|e| e.kind == "call")
            .map(|e| (e.source_symbol.as_deref().unwrap_or(""), e.target_name.as_str()))
            .collect()
    }

    #[test]
    fn extracts_python_structure_and_calls() {
        let code = "import os\n\ndef helper(value):\n    return os.path.join(value)\n\nclass Service:\n    def run(self):\n        return helper('x')\n";
        let file = extract(code, "py");
        assert!(names(&file).contains(&"helper"));
        assert!(names(&file).contains(&"Service"));
        assert!(names(&file).contains(&"run"));
        // The call is attributed to the method that makes it.
        assert!(calls(&file).contains(&("run", "helper")));
        assert!(file.edges.iter().any(|e| e.kind == "import"));
        // Multi-line spans, not single-line anchors.
        let service = file.symbols.iter().find(|s| s.name == "Service").unwrap();
        assert!(service.end_line > service.start_line);
    }

    #[test]
    fn extracts_go_structure_and_visibility() {
        let code = "package main\n\nimport \"fmt\"\n\ntype Server struct {\n\tAddr string\n}\n\nfunc Serve(s *Server) {\n\tfmt.Println(s.Addr)\n}\n\nfunc internal() {\n\tServe(nil)\n}\n";
        let file = extract(code, "go");
        assert!(names(&file).contains(&"Server"));
        assert!(names(&file).contains(&"Serve"));
        assert!(calls(&file).contains(&("internal", "Serve")));
        let serve = file.symbols.iter().find(|s| s.name == "Serve").unwrap();
        assert!(serve.exported, "an exported Go name starts with a capital");
        let internal = file.symbols.iter().find(|s| s.name == "internal").unwrap();
        assert!(!internal.exported);
    }

    #[test]
    fn extracts_rust_structure() {
        let code = "use std::io::Read;\n\npub struct Engine {\n    size: usize,\n}\n\nimpl Engine {\n    pub fn start(&self) -> usize {\n        self.compute()\n    }\n    fn compute(&self) -> usize {\n        self.size\n    }\n}\n";
        let file = extract(code, "rs");
        assert!(names(&file).contains(&"Engine"));
        assert!(names(&file).contains(&"start"));
        assert!(calls(&file).contains(&("start", "compute")));
        let start = file.symbols.iter().find(|s| s.name == "start").unwrap();
        assert!(start.exported, "pub fn is exported");
    }

    #[test]
    fn extracts_c_and_cpp_declarators() {
        let c = extract(
            "#include <stdio.h>\n\nstatic int helper(int x) { return x + 1; }\n\nint Run(int x) { return helper(x); }\n",
            "c",
        );
        assert!(names(&c).contains(&"helper"));
        assert!(names(&c).contains(&"Run"));
        assert!(calls(&c).contains(&("Run", "helper")));
        assert!(c.edges.iter().any(|e| e.kind == "import"));

        let cpp = extract(
            "namespace app {\nclass Engine {\npublic:\n  int Start();\n};\nint Engine::Start() { return 1; }\n}\n",
            "cpp",
        );
        assert!(names(&cpp).contains(&"Engine"));
        assert!(names(&cpp).contains(&"app"));
    }

    #[test]
    fn unknown_extensions_report_no_language() {
        let file = extract("some prose", "txt");
        assert!(file.language.is_none());
        assert!(file.symbols.is_empty());
    }
}
