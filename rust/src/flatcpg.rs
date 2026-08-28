use std::collections::HashMap;
use tree_sitter::{Node, Parser};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum EdgeKind {
    Call = 0,
    DataFlow = 1,
    ControlFlow = 2,
    Import = 3,
}

#[derive(Debug, Clone)]
pub struct FlatCPG {
    pub node_types: Vec<u16>,
    pub symbol_names: Vec<String>,
    pub file_indices: Vec<u32>,
    pub line_spans: Vec<(u32, u32)>,
    pub edge_heads: Vec<u32>,
    pub edge_tails: Vec<u32>,
    pub edge_kinds: Vec<u8>,
}

impl FlatCPG {
    pub fn new() -> Self {
        Self {
            node_types: Vec::new(),
            symbol_names: Vec::new(),
            file_indices: Vec::new(),
            line_spans: Vec::new(),
            edge_heads: Vec::new(),
            edge_tails: Vec::new(),
            edge_kinds: Vec::new(),
        }
    }

    pub fn add_node(&mut self, node_type: u16, symbol: String, file_idx: u32, span: (u32, u32)) -> u32 {
        let idx = self.node_types.len() as u32;
        self.node_types.push(node_type);
        self.symbol_names.push(symbol);
        self.file_indices.push(file_idx);
        self.line_spans.push(span);
        idx
    }

    pub fn add_edge(&mut self, head: u32, tail: u32, kind: EdgeKind) {
        self.edge_heads.push(head);
        self.edge_tails.push(tail);
        self.edge_kinds.push(kind as u8);
    }

    pub fn compute_ppr_slice(&self, seed_nodes: &[u32], alpha: f32, iterations: usize, threshold: f32) -> Vec<u32> {
        let n = self.node_types.len();
        if n == 0 || seed_nodes.is_empty() {
            return Vec::new();
        }

        let mut adj: HashMap<u32, Vec<u32>> = HashMap::new();
        for i in 0..self.edge_heads.len() {
            let u = self.edge_heads[i];
            let v = self.edge_tails[i];
            adj.entry(u).or_default().push(v);
            adj.entry(v).or_default().push(u); 
        }

        let mut p = vec![0.0; n];
        let initial_prob = 1.0 / seed_nodes.len() as f32;
        
        for &seed in seed_nodes {
            if (seed as usize) < n {
                p[seed as usize] = initial_prob;
            }
        }

        let mut next_p = p.clone();

        for _ in 0..iterations {
            for i in 0..n {
                next_p[i] = 0.0;
            }

            for u in 0..n {
                if p[u] > 0.0 {
                    if let Some(neighbors) = adj.get(&(u as u32)) {
                        let out_degree = neighbors.len() as f32;
                        for &v in neighbors {
                            next_p[v as usize] += (1.0 - alpha) * (p[u] / out_degree);
                        }
                    }
                }
            }

            for &seed in seed_nodes {
                if (seed as usize) < n {
                    next_p[seed as usize] += alpha * initial_prob;
                }
            }

            p.copy_from_slice(&next_p);
        }

        let mut slice = Vec::new();
        for (i, &prob) in p.iter().enumerate() {
            if prob >= threshold {
                slice.push(i as u32);
            }
        }

        slice
    }
}

pub fn slice_ast(code: &str, ext: &str, symbols: &[String]) -> Vec<String> {
    let language = match ext {
        "ts" | "tsx" | "js" | "jsx" => Some(tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()),
        "py" => Some(tree_sitter_python::LANGUAGE.into()),
        "rs" => Some(tree_sitter_rust::LANGUAGE.into()),
        _ => None,
    };

    if let Some(lang) = language {
        let mut parser = Parser::new();
        parser.set_language(&lang).unwrap();
        let tree = parser.parse(code, None).unwrap();
        let mut results = Vec::new();
        let root = tree.root_node();
        walk_tree(root, code, symbols, &mut results);
        results
    } else {
        fallback_slice(code, symbols)
    }
}

fn walk_tree(node: Node, code: &str, symbols: &[String], results: &mut Vec<String>) {
    // Universal symbol extraction: if a node has a "name" field, check if it matches.
    if let Some(name_node) = node.child_by_field_name("name") {
        if let Ok(name) = name_node.utf8_text(code.as_bytes()) {
            if symbols.iter().any(|s| s == name) {
                if let Ok(text) = node.utf8_text(code.as_bytes()) {
                    results.push(text.to_string());
                }
            }
        }
    }
    
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        walk_tree(child, code, symbols, results);
    }
}

fn fallback_slice(code: &str, symbols: &[String]) -> Vec<String> {
    let mut results = Vec::new();
    let lines: Vec<&str> = code.lines().collect();
    
    for symbol in symbols {
        let mut i = 0;
        while i < lines.len() {
            let line = lines[i];
            
            // Check if this line looks like a declaration for the symbol.
            let is_decl = line.contains(symbol) && 
                (line.contains("def ") || line.contains("class ") || line.contains("function ") || 
                 line.contains("struct ") || line.contains("interface ") || line.contains("pub fn ") ||
                 line.contains("fn "));
                 
            if is_decl {
                let base_indent = line.chars().take_while(|c| c.is_whitespace()).count();
                let mut block = String::new();
                block.push_str(line);
                block.push('\n');
                
                i += 1;
                while i < lines.len() {
                    let next_line = lines[i];
                    if next_line.trim().is_empty() {
                        block.push_str(next_line);
                        block.push('\n');
                        i += 1;
                        continue;
                    }
                    
                    let next_indent = next_line.chars().take_while(|c| c.is_whitespace()).count();
                    
                    // Stop if we hit a line with lesser or equal indentation, 
                    // unless it's a closing brace which we include.
                    if next_indent <= base_indent {
                        let trimmed = next_line.trim();
                        if trimmed == "}" || trimmed == "end" || trimmed == "};" {
                            block.push_str(next_line);
                            block.push('\n');
                        }
                        break;
                    }
                    
                    block.push_str(next_line);
                    block.push('\n');
                    i += 1;
                }
                results.push(block);
            } else {
                i += 1;
            }
        }
    }
    
    results
}

pub fn prune_to_signatures(code: &str, ext: &str) -> String {
    let language = match ext {
        "ts" | "tsx" | "js" | "jsx" => Some(tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()),
        "py" => Some(tree_sitter_python::LANGUAGE.into()),
        "rs" => Some(tree_sitter_rust::LANGUAGE.into()),
        _ => None,
    };

    if let Some(lang) = language {
        let mut parser = Parser::new();
        parser.set_language(&lang).unwrap();
        let tree = parser.parse(code, None).unwrap();
        let root = tree.root_node();
        
        let mut prune_spans = Vec::new();
        collect_prune_spans(root, &mut prune_spans);
        
        // Sort spans by start_byte just in case
        prune_spans.sort_by_key(|&(start, _)| start);
        
        let placeholder = if ext == "py" { "\n        pass\n    " } else { " { ... } " };
        
        let mut result = String::new();
        let mut last_end = 0;
        
        let bytes = code.as_bytes();
        for (start, end) in prune_spans {
            if start > last_end {
                if let Ok(s) = std::str::from_utf8(&bytes[last_end..start]) {
                    result.push_str(s);
                }
            }
            result.push_str(placeholder);
            last_end = end;
        }
        
        if last_end < bytes.len() {
            if let Ok(s) = std::str::from_utf8(&bytes[last_end..]) {
                result.push_str(s);
            }
        }
        
        result
    } else {
        // Fallback: Just return the original code (or a simple truncation)
        code.to_string()
    }
}

fn collect_prune_spans(node: Node, spans: &mut Vec<(usize, usize)>) {
    let kind = node.kind();
    let is_func = kind == "function_declaration" || 
                  kind == "method_definition" || 
                  kind == "arrow_function" ||
                  kind == "function_item" ||
                  kind == "function_definition";
                  
    if is_func {
        if let Some(body) = node.child_by_field_name("body") {
            spans.push((body.start_byte(), body.end_byte()));
            // Do not traverse into the body
            return;
        }
    }
    
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        collect_prune_spans(child, spans);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_universal_python_ast_slice() {
        let code = r#"
def not_me():
    pass

class MyTarget:
    def __init__(self):
        self.val = 1
"#;
        let symbols = vec!["MyTarget".to_string()];
        let slices = slice_ast(code, "py", &symbols);
        assert_eq!(slices.len(), 1);
        assert!(slices[0].contains("class MyTarget:"));
        assert!(slices[0].contains("self.val = 1"));
    }

    #[test]
    fn test_fallback_ruby_slice() {
        let code = r#"
def ignored
  puts "ignored"
end

def my_target(args)
  puts "found it"
  if args
    puts "nested"
  end
end

def another
end
"#;
        let symbols = vec!["my_target".to_string()];
        // "rb" will fall back to fallback_slice since we don't have tree-sitter-ruby linked
        let slices = slice_ast(code, "rb", &symbols);
        assert_eq!(slices.len(), 1);
        assert!(slices[0].contains("def my_target"));
        assert!(slices[0].contains("puts \"nested\""));
        assert!(!slices[0].contains("def another"));
    }

    #[test]
    fn test_prune_to_signatures() {
        let code = r#"
class MyTarget {
    constructor() {
        this.val = 1;
    }
    
    do_something() {
        console.log("hello");
    }
}
"#;
        let pruned = prune_to_signatures(code, "ts");
        assert!(pruned.contains("class MyTarget"));
        assert!(pruned.contains("constructor()  { ... }"));
        assert!(pruned.contains("do_something()  { ... }"));
        assert!(!pruned.contains("console.log"));
    }
}
