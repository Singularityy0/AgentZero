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

pub fn slice_ast(code: &str, symbols: &[String]) -> Vec<String> {
    let mut parser = Parser::new();
    parser.set_language(&tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into()).unwrap();
    let tree = parser.parse(code, None).unwrap();
    let mut results = Vec::new();
    let root = tree.root_node();
    walk_tree(root, code, symbols, &mut results);
    results
}

fn walk_tree(node: Node, code: &str, symbols: &[String], results: &mut Vec<String>) {
    let kind = node.kind();
    if kind == "function_declaration" || kind == "method_definition" || kind == "class_declaration" {
        if let Some(name_node) = node.child_by_field_name("name") {
            if let Ok(name) = name_node.utf8_text(code.as_bytes()) {
                if symbols.iter().any(|s| s == name) {
                    if let Ok(text) = node.utf8_text(code.as_bytes()) {
                        results.push(text.to_string());
                    }
                }
            }
        }
    }
    
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        walk_tree(child, code, symbols, results);
    }
}
