use serde::{Deserialize, Serialize};

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
        if original == proposal {
            return Vec::new();
        }

        let original_lines: Vec<&str> = original.split('\n').collect();
        let proposal_lines: Vec<&str> = proposal.split('\n').collect();
        let cell_count = original_lines.len().saturating_mul(proposal_lines.len());

        if cell_count > 4_000_000 {
            return vec![Self::trimmed_replacement(&original_lines, &proposal_lines)];
        }

        Self::lcs_chunks(&original_lines, &proposal_lines)
    }

    fn lcs_chunks(original: &[&str], proposal: &[&str]) -> Vec<DiffChunk> {
        let mut lengths = vec![vec![0_u32; proposal.len() + 1]; original.len() + 1];
        for original_index in (0..original.len()).rev() {
            for proposal_index in (0..proposal.len()).rev() {
                lengths[original_index][proposal_index] =
                    if original[original_index] == proposal[proposal_index] {
                        lengths[original_index + 1][proposal_index + 1] + 1
                    } else {
                        lengths[original_index + 1][proposal_index]
                            .max(lengths[original_index][proposal_index + 1])
                    };
            }
        }

        let mut chunks = Vec::new();
        let mut original_index = 0;
        let mut proposal_index = 0;

        while original_index < original.len() || proposal_index < proposal.len() {
            if original_index < original.len()
                && proposal_index < proposal.len()
                && original[original_index] == proposal[proposal_index]
            {
                original_index += 1;
                proposal_index += 1;
                continue;
            }

            let start = original_index;
            let mut replacement = Vec::new();
            while original_index < original.len() || proposal_index < proposal.len() {
                if original_index < original.len()
                    && proposal_index < proposal.len()
                    && original[original_index] == proposal[proposal_index]
                {
                    break;
                }

                if proposal_index < proposal.len()
                    && (original_index == original.len()
                        || lengths[original_index][proposal_index + 1]
                            >= lengths[original_index + 1][proposal_index])
                {
                    replacement.push(proposal[proposal_index]);
                    proposal_index += 1;
                } else {
                    original_index += 1;
                }
            }

            chunks.push(DiffChunk {
                start_line: (start + 1) as u32,
                end_line: (original_index + 1) as u32,
                replacement: replacement.join("\n"),
            });
        }

        chunks
    }

    fn trimmed_replacement(original: &[&str], proposal: &[&str]) -> DiffChunk {
        let mut prefix = 0;
        while prefix < original.len()
            && prefix < proposal.len()
            && original[prefix] == proposal[prefix]
        {
            prefix += 1;
        }

        let mut original_suffix = original.len();
        let mut proposal_suffix = proposal.len();
        while original_suffix > prefix
            && proposal_suffix > prefix
            && original[original_suffix - 1] == proposal[proposal_suffix - 1]
        {
            original_suffix -= 1;
            proposal_suffix -= 1;
        }

        DiffChunk {
            start_line: (prefix + 1) as u32,
            end_line: (original_suffix + 1) as u32,
            replacement: proposal[prefix..proposal_suffix].join("\n"),
        }
    }

    pub fn apply_partial_merge(original_source: &str, approved_chunks: &[DiffChunk]) -> String {
        if approved_chunks.is_empty() {
            return original_source.to_string();
        }

        let mut lines: Vec<String> = original_source.split('\n').map(str::to_string).collect();
        let mut sorted_chunks = approved_chunks.to_vec();
        sorted_chunks.sort_by(|left, right| right.start_line.cmp(&left.start_line));

        for chunk in sorted_chunks {
            let start_index = chunk.start_line.saturating_sub(1) as usize;
            let end_index = chunk.end_line.saturating_sub(1) as usize;
            if start_index > end_index || end_index > lines.len() {
                continue;
            }

            let replacement_lines = if chunk.replacement.is_empty() {
                Vec::new()
            } else {
                chunk.replacement.split('\n').map(str::to_string).collect()
            };
            lines.splice(start_index..end_index, replacement_lines);
        }

        lines.join("\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computes_separate_minimal_hunks() {
        let chunks = DiffEngine::compute_diff("a\nb\nc\nd\ne", "a\nB\nc\nd\nE");

        assert_eq!(
            chunks,
            vec![
                DiffChunk {
                    start_line: 2,
                    end_line: 3,
                    replacement: "B".to_string(),
                },
                DiffChunk {
                    start_line: 5,
                    end_line: 6,
                    replacement: "E".to_string(),
                },
            ]
        );
    }

    #[test]
    fn applies_only_approved_hunks() {
        let original = "a\nb\nc\nd\ne";
        let chunks = DiffEngine::compute_diff(original, "a\nB\nc\nd\nE");

        assert_eq!(
            DiffEngine::apply_partial_merge(original, &chunks[..1]),
            "a\nB\nc\nd\ne"
        );
    }

    #[test]
    fn handles_insertions_and_deletions() {
        let insertion = DiffEngine::compute_diff("a\nc", "a\nb\nc");
        assert_eq!(
            DiffEngine::apply_partial_merge("a\nc", &insertion),
            "a\nb\nc"
        );

        let deletion = DiffEngine::compute_diff("a\nb\nc", "a\nc");
        assert_eq!(
            DiffEngine::apply_partial_merge("a\nb\nc", &deletion),
            "a\nc"
        );
    }
}
