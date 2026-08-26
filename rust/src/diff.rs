use serde::{Serialize, Deserialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiffChunk {
    pub start_line: u32,
    pub end_line: u32,
    pub replacement: String,
}

pub struct DiffEngine;

impl DiffEngine {
    pub fn new() -> Self {
        Self
    }

    pub fn compute_diff(original: &str, proposal: &str) -> Vec<DiffChunk> {
        let orig_lines: Vec<&str> = original.lines().collect();
        let prop_lines: Vec<&str> = proposal.lines().collect();

        if orig_lines == prop_lines {
            return Vec::new();
        }

        vec![DiffChunk {
            start_line: 1,
            end_line: (orig_lines.len() as u32) + 1,
            replacement: proposal.to_string(),
        }]
    }
    
    pub fn apply_partial_merge(original_source: &str, approved_chunks: &[DiffChunk]) -> String {
        if approved_chunks.is_empty() {
            return original_source.to_string();
        }

        let mut lines: Vec<String> = original_source.lines().map(|s| s.to_string()).collect();
        
        let mut sorted_chunks = approved_chunks.to_vec();
        sorted_chunks.sort_by(|a, b| b.start_line.cmp(&a.start_line));

        for chunk in sorted_chunks {
            let start_idx = (chunk.start_line.saturating_sub(1)) as usize;
            let end_idx = (chunk.end_line.saturating_sub(1)) as usize;
            
            if start_idx <= lines.len() && end_idx <= lines.len() {
                let replacement_lines: Vec<String> = chunk.replacement.lines().map(|s| s.to_string()).collect();
                lines.splice(start_idx..end_idx, replacement_lines);
            }
        }
        
        lines.join("\n")
    }
}
