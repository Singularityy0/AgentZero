use std::collections::HashMap;

/// Edge kinds for the FlatCPG graph
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum EdgeKind {
    Call = 0,
    DataFlow = 1,
    ControlFlow = 2,
    Import = 3,
}

/// Cache-Oblivious FlatCPG & Tree-Sitter AST Slicer
/// Uses a Structure of Arrays (SoA) layout for high performance memory access.
#[derive(Debug, Clone)]
pub struct FlatCPG {
    pub node_types: Vec<u16>,
    pub symbol_names: Vec<String>,
    pub file_indices: Vec<u32>,
    pub line_spans: Vec<(u32, u32)>,
    
    // Graph Edges
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

    /// Adds a node and returns its index
    pub fn add_node(&mut self, node_type: u16, symbol: String, file_idx: u32, span: (u32, u32)) -> u32 {
        let idx = self.node_types.len() as u32;
        self.node_types.push(node_type);
        self.symbol_names.push(symbol);
        self.file_indices.push(file_idx);
        self.line_spans.push(span);
        idx
    }

    /// Adds a directed edge from head (source) to tail (target)
    pub fn add_edge(&mut self, head: u32, tail: u32, kind: EdgeKind) {
        self.edge_heads.push(head);
        self.edge_tails.push(tail);
        self.edge_kinds.push(kind as u8);
    }

    /// Compute Bi-Directional Personalized PageRank (PPR)
    /// Given a set of seed nodes (e.g., from a user prompt), this computes the stationary distribution
    /// and returns the indices of the most relevant nodes.
    pub fn compute_ppr_slice(&self, seed_nodes: &[u32], alpha: f32, iterations: usize, threshold: f32) -> Vec<u32> {
        let n = self.node_types.len();
        if n == 0 || seed_nodes.is_empty() {
            return Vec::new();
        }

        // Build adjacency list for efficient traversal
        let mut adj: HashMap<u32, Vec<u32>> = HashMap::new();
        for i in 0..self.edge_heads.len() {
            let u = self.edge_heads[i];
            let v = self.edge_tails[i];
            adj.entry(u).or_default().push(v);
            // Treat as undirected/bi-directional for context spreading
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

            // Add teleportation to seed nodes
            for &seed in seed_nodes {
                if (seed as usize) < n {
                    next_p[seed as usize] += alpha * initial_prob;
                }
            }

            p.copy_from_slice(&next_p);
        }

        // Filter nodes above threshold
        let mut slice = Vec::new();
        for (i, &prob) in p.iter().enumerate() {
            if prob >= threshold {
                slice.push(i as u32);
            }
        }

        slice
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_flatcpg_creation() {
        let mut cpg = FlatCPG::new();
        let n1 = cpg.add_node(1, "main".to_string(), 0, (1, 10));
        let n2 = cpg.add_node(2, "helper".to_string(), 0, (12, 20));
        cpg.add_edge(n1, n2, EdgeKind::Call);

        assert_eq!(cpg.node_types.len(), 2);
        assert_eq!(cpg.edge_heads.len(), 1);
    }
    
    #[test]
    fn test_ppr_slicing() {
        let mut cpg = FlatCPG::new();
        let n0 = cpg.add_node(1, "A".to_string(), 0, (1, 2));
        let n1 = cpg.add_node(1, "B".to_string(), 0, (3, 4));
        let n2 = cpg.add_node(1, "C".to_string(), 0, (5, 6));
        
        cpg.add_edge(n0, n1, EdgeKind::Call);
        cpg.add_edge(n1, n2, EdgeKind::Call);
        
        let slice = cpg.compute_ppr_slice(&[n0], 0.15, 10, 0.01);
        assert!(!slice.is_empty());
        assert!(slice.contains(&n0));
        assert!(slice.contains(&n1)); // B is connected to A, should be in the slice
    }
}
