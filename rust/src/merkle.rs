use blake3::Hasher;
use std::collections::VecDeque;

/// Represents a snapshot of the workspace state after a task step
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StateSnapshot {
    pub hash: [u8; 32],
}

impl StateSnapshot {
    /// Computes the BLAKE3 hash for the current state
    ///
    /// `file_hashes`: The hashes of all tracked files in the workspace
    /// `cmd`: The command executed in this step (if any)
    /// `exit_code`: The exit code of the command (if any)
    pub fn new(file_hashes: &[[u8; 32]], cmd: Option<&str>, exit_code: Option<i32>) -> Self {
        let mut hasher = Hasher::new();
        
        for hash in file_hashes {
            hasher.update(hash);
        }
        
        if let Some(c) = cmd {
            hasher.update(c.as_bytes());
        }
        
        if let Some(code) = exit_code {
            hasher.update(&code.to_le_bytes());
        }
        
        let mut hash = [0; 32];
        hash.copy_from_slice(hasher.finalize().as_bytes());
        
        Self { hash }
    }
}

/// Maintains a rolling history of state snapshots to detect cycles
pub struct StateTree {
    history: VecDeque<StateSnapshot>,
    max_history: usize,
}

impl StateTree {
    /// Creates a new StateTree with a maximum history size (rolling K buffer)
    pub fn new(max_history: usize) -> Self {
        Self {
            history: VecDeque::with_capacity(max_history),
            max_history,
        }
    }

    /// Adds a new snapshot and checks if it forms a cycle with previous states
    /// Returns `Some(steps_ago)` if a cycle is detected, where `steps_ago` is how far back the cycle starts.
    /// Returns `None` if no cycle is detected.
    pub fn push_and_check_cycle(&mut self, snapshot: StateSnapshot) -> Option<usize> {
        // Check for cycle before adding
        for (i, past_snapshot) in self.history.iter().rev().enumerate() {
            if past_snapshot.hash == snapshot.hash {
                self.history.push_back(snapshot);
                if self.history.len() > self.max_history {
                    self.history.pop_front();
                }
                return Some(i + 1);
            }
        }

        self.history.push_back(snapshot);
        if self.history.len() > self.max_history {
            self.history.pop_front();
        }
        None
    }

    /// Clears the history buffer
    pub fn clear(&mut self) {
        self.history.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cycle_detection() {
        let mut tree = StateTree::new(10);
        let file_hashes = vec![[1; 32]];
        
        let s1 = StateSnapshot::new(&file_hashes, Some("ls"), Some(0));
        let s2 = StateSnapshot::new(&file_hashes, Some("pwd"), Some(0));
        
        assert_eq!(tree.push_and_check_cycle(s1.clone()), None);
        assert_eq!(tree.push_and_check_cycle(s2.clone()), None);
        
        // Push s1 again to simulate a cycle
        assert_eq!(tree.push_and_check_cycle(s1), Some(2));
    }
}
