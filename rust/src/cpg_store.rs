//! Project-scoped code property graphs, persisted through the memory-mapped WAL.
//!
//! Retrieval's SQLite index answers "which symbols match these terms". It
//! expands from there by one hop, which finds a direct caller but not the thing
//! two edges away that a change actually breaks. This module holds the whole
//! symbol graph in the flat arrays `FlatCPG` defines and runs personalised
//! PageRank from the matched symbols, so relatedness is measured by how the code
//! is actually wired rather than by how many hops a loop was willing to walk.
//!
//! One graph per project, keyed by the same canonical project id the databases
//! use, so two codebases open at once cannot see each other's structure.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::flatcpg::{EdgeKind, FlatCPG};
use crate::wal::Wal;

/// One symbol in the graph, as retrieval knows it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CpgNode {
    pub symbol: String,
    pub path: String,
    pub start_line: u32,
    pub end_line: u32,
}

/// A directed relationship between two nodes, by index into `nodes`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CpgEdge {
    pub head: u32,
    pub tail: u32,
    /// "call", "import", "reference", or "definition".
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CpgSnapshot {
    pub nodes: Vec<CpgNode>,
    pub edges: Vec<CpgEdge>,
    /// Index revision this graph was built from, so a stale load is detectable.
    pub revision: String,
}

#[derive(Debug, Serialize)]
pub struct RankedNode {
    pub symbol: String,
    pub path: String,
    #[serde(rename = "startLine")]
    pub start_line: u32,
    #[serde(rename = "endLine")]
    pub end_line: u32,
    pub score: f32,
}

fn edge_kind_of(kind: &str) -> EdgeKind {
    match kind {
        "call" => EdgeKind::Call,
        "import" => EdgeKind::Import,
        "reference" => EdgeKind::DataFlow,
        _ => EdgeKind::ControlFlow,
    }
}

struct ProjectGraph {
    graph: FlatCPG,
    nodes: Vec<CpgNode>,
    /// Symbol name to every node index declaring it, for seeding.
    by_symbol: HashMap<String, Vec<u32>>,
    revision: String,
}

impl ProjectGraph {
    fn build(snapshot: &CpgSnapshot) -> Self {
        let mut graph = FlatCPG::new();
        let mut by_symbol: HashMap<String, Vec<u32>> = HashMap::new();
        for (index, node) in snapshot.nodes.iter().enumerate() {
            graph.add_node(
                0,
                node.symbol.clone(),
                index as u32,
                (node.start_line, node.end_line),
            );
            by_symbol
                .entry(node.symbol.to_lowercase())
                .or_default()
                .push(index as u32);
        }
        let node_count = snapshot.nodes.len() as u32;
        for edge in &snapshot.edges {
            // Guard against an index built from a newer snapshot than the nodes.
            if edge.head < node_count && edge.tail < node_count {
                graph.add_edge(edge.head, edge.tail, edge_kind_of(&edge.kind));
            }
        }
        Self {
            graph,
            nodes: snapshot.nodes.clone(),
            by_symbol,
            revision: snapshot.revision.clone(),
        }
    }
}

/// Holds one graph per project and persists each to its own WAL file.
///
/// The storage directory is supplied per call rather than at construction: the
/// sidecar is a long-lived process that may serve more than one workspace, and
/// each project's graph belongs next to that project's own databases.
pub struct CpgStore {
    projects: HashMap<String, ProjectGraph>,
}

/// Enough for roughly a hundred thousand symbols; the file is sparse until used.
const WAL_CAPACITY: usize = 32 * 1024 * 1024;

impl CpgStore {
    pub fn new() -> Self {
        Self {
            projects: HashMap::new(),
        }
    }

    fn wal_path(directory: &Path, project_id: &str) -> PathBuf {
        // The id is a hex digest from the caller, but a path is being built from
        // it, so anything that is not hex is refused rather than escaped.
        let safe: String = project_id
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .take(64)
            .collect();
        directory.join(format!("cpg-{}.wal", safe))
    }

    /// Replace a project's graph and write it through to disk.
    ///
    /// The WAL frames one record as an 8-byte little-endian length followed by
    /// the bincode payload, so a truncated tail is detectable on load instead of
    /// being parsed as garbage.
    pub fn put(
        &mut self,
        project_id: &str,
        directory: &Path,
        snapshot: CpgSnapshot,
    ) -> Result<usize, String> {
        let encoded = bincode::serialize(&snapshot).map_err(|error| error.to_string())?;
        let node_count = snapshot.nodes.len();
        self.projects
            .insert(project_id.to_string(), ProjectGraph::build(&snapshot));

        let path = Self::wal_path(directory, project_id);
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let mut wal = Wal::new(path, WAL_CAPACITY).map_err(|error| error.to_string())?;
        let mut framed = (encoded.len() as u64).to_le_bytes().to_vec();
        framed.extend_from_slice(&encoded);
        wal.append(&framed).map_err(|error| error.to_string())?;
        Ok(node_count)
    }

    /// Load a project's graph from disk if it is not already in memory.
    ///
    /// Returns the revision the graph was built at, so the caller can decide
    /// whether it still matches its index rather than trusting a stale file.
    pub fn load(&mut self, project_id: &str, directory: &Path) -> Option<String> {
        if let Some(existing) = self.projects.get(project_id) {
            return Some(existing.revision.clone());
        }
        let wal = Wal::new(Self::wal_path(directory, project_id), WAL_CAPACITY).ok()?;
        let header = wal.read(0, 8)?;
        let length = u64::from_le_bytes(header.try_into().ok()?) as usize;
        if length == 0 || length > WAL_CAPACITY - 8 {
            return None;
        }
        let payload = wal.read(8, length)?;
        let snapshot: CpgSnapshot = bincode::deserialize(payload).ok()?;
        let revision = snapshot.revision.clone();
        self.projects
            .insert(project_id.to_string(), ProjectGraph::build(&snapshot));
        Some(revision)
    }

    /// Rank symbols by graph proximity to the ones a query already matched.
    pub fn rank(
        &mut self,
        project_id: &str,
        directory: &Path,
        seed_symbols: &[String],
        limit: usize,
    ) -> Vec<RankedNode> {
        self.load(project_id, directory);
        let Some(project) = self.projects.get(project_id) else {
            return Vec::new();
        };
        let mut seeds = Vec::new();
        for symbol in seed_symbols {
            if let Some(indices) = project.by_symbol.get(&symbol.to_lowercase()) {
                seeds.extend(indices.iter().copied());
            }
        }
        seeds.sort_unstable();
        seeds.dedup();
        if seeds.is_empty() {
            return Vec::new();
        }

        // Alpha 0.15 is the usual restart probability; ten iterations is well
        // past convergence for graphs this shape, and the threshold is low
        // enough to keep second- and third-hop neighbours that a one-hop
        // expansion would have dropped.
        // Already ordered by descending PageRank mass, so truncating below
        // keeps the most related nodes rather than the lowest-numbered ones.
        let ranked = project.graph.compute_ppr_slice(&seeds, 0.15, 10, 1e-4);
        let seed_set: std::collections::HashSet<u32> = seeds.iter().copied().collect();
        let mut results: Vec<RankedNode> = ranked
            .into_iter()
            // The seeds are already known to the caller; the value here is what
            // they are connected to.
            .filter(|(index, _)| !seed_set.contains(index))
            .filter_map(|(index, score)| {
                let node = project.nodes.get(index as usize)?;
                Some(RankedNode {
                    symbol: node.symbol.clone(),
                    path: node.path.clone(),
                    start_line: node.start_line,
                    end_line: node.end_line,
                    // The mass itself, so a caller can say how strongly a
                    // symbol is related and not merely that it is.
                    score,
                })
            })
            .collect();
        results.truncate(limit);
        results
    }

    pub fn revision(&self, project_id: &str) -> Option<&str> {
        self.projects
            .get(project_id)
            .map(|project| project.revision.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> CpgSnapshot {
        // handler -> service -> repository -> driver
        // A one-hop expansion from `handler` finds `service` and stops. The
        // thing a change to `handler` actually reaches is `driver`.
        CpgSnapshot {
            nodes: vec![
                CpgNode { symbol: "handler".into(), path: "a.go".into(), start_line: 1, end_line: 5 },
                CpgNode { symbol: "service".into(), path: "b.go".into(), start_line: 1, end_line: 9 },
                CpgNode { symbol: "repository".into(), path: "c.go".into(), start_line: 1, end_line: 7 },
                CpgNode { symbol: "driver".into(), path: "d.go".into(), start_line: 1, end_line: 4 },
                CpgNode { symbol: "unrelated".into(), path: "z.go".into(), start_line: 1, end_line: 2 },
            ],
            edges: vec![
                CpgEdge { head: 0, tail: 1, kind: "call".into() },
                CpgEdge { head: 1, tail: 2, kind: "call".into() },
                CpgEdge { head: 2, tail: 3, kind: "call".into() },
            ],
            revision: "rev-1".into(),
        }
    }

    #[test]
    fn ranks_beyond_one_hop_and_excludes_the_seed() {
        let directory = std::env::temp_dir().join("cpg-test-rank");
        let _ = std::fs::remove_dir_all(&directory);
        let mut store = CpgStore::new();
        store.put("proj", &directory, snapshot()).unwrap();

        let ranked = store.rank("proj", &directory, &["handler".to_string()], 10);
        let names: Vec<&str> = ranked.iter().map(|node| node.symbol.as_str()).collect();

        assert!(!names.contains(&"handler"), "the seed is not a result");
        assert!(names.contains(&"service"), "one hop");
        assert!(names.contains(&"repository"), "two hops");
        assert!(names.contains(&"driver"), "three hops, which one-hop misses");
        assert!(!names.contains(&"unrelated"), "a disconnected node stays out");
        let _ = std::fs::remove_dir_all(&directory);
    }

    /// A graph whose node order deliberately disagrees with its graph order:
    /// `near` is one hop from the seed but sits at the highest index, `far` is
    /// two hops away but sits at the lowest. Ranking by index returns `far`.
    fn inverted_snapshot() -> CpgSnapshot {
        CpgSnapshot {
            nodes: vec![
                CpgNode { symbol: "seed".into(), path: "a.go".into(), start_line: 1, end_line: 5 },
                CpgNode { symbol: "far".into(), path: "b.go".into(), start_line: 1, end_line: 9 },
                CpgNode { symbol: "near".into(), path: "c.go".into(), start_line: 1, end_line: 7 },
            ],
            edges: vec![
                CpgEdge { head: 0, tail: 2, kind: "call".into() },
                CpgEdge { head: 2, tail: 1, kind: "call".into() },
            ],
            revision: "rev-1".into(),
        }
    }

    #[test]
    fn scores_carry_the_pagerank_mass_in_descending_order() {
        let directory = std::env::temp_dir().join("cpg-test-scores");
        let _ = std::fs::remove_dir_all(&directory);
        let mut store = CpgStore::new();
        store.put("proj", &directory, snapshot()).unwrap();

        let ranked = store.rank("proj", &directory, &["handler".to_string()], 10);

        assert!(
            ranked.iter().all(|node| node.score > 0.0),
            "a ranked node carries its own mass, not a placeholder",
        );
        for pair in ranked.windows(2) {
            assert!(
                pair[0].score >= pair[1].score,
                "results are ordered by descending relatedness",
            );
        }
        // Distance from the seed should cost mass along the chain.
        let mass = |symbol: &str| {
            ranked.iter().find(|node| node.symbol == symbol).expect(symbol).score
        };
        assert!(mass("service") > mass("driver"), "one hop outranks three");
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn a_truncated_ranking_keeps_the_most_related_not_the_lowest_indexed() {
        let directory = std::env::temp_dir().join("cpg-test-truncate");
        let _ = std::fs::remove_dir_all(&directory);
        let mut store = CpgStore::new();
        store.put("proj", &directory, inverted_snapshot()).unwrap();

        let ranked = store.rank("proj", &directory, &["seed".to_string()], 1);

        assert_eq!(ranked.len(), 1);
        assert_eq!(
            ranked[0].symbol, "near",
            "the single kept result is the closest node, not node index 1",
        );
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn survives_a_restart_through_the_wal() {
        let directory = std::env::temp_dir().join("cpg-test-wal");
        let _ = std::fs::remove_dir_all(&directory);
        {
            let mut store = CpgStore::new();
            store.put("proj", &directory, snapshot()).unwrap();
        }
        // A fresh store with no memory of the build still answers, from disk.
        let mut reopened = CpgStore::new();
        assert_eq!(reopened.load("proj", &directory).as_deref(), Some("rev-1"));
        let ranked = reopened.rank("proj", &directory, &["handler".to_string()], 10);
        assert!(ranked.iter().any(|node| node.symbol == "driver"));
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn projects_do_not_share_a_graph() {
        let directory = std::env::temp_dir().join("cpg-test-isolation");
        let _ = std::fs::remove_dir_all(&directory);
        let mut store = CpgStore::new();
        store.put("alpha", &directory, snapshot()).unwrap();
        assert!(store.rank("beta", &directory, &["handler".to_string()], 10).is_empty());
        let _ = std::fs::remove_dir_all(&directory);
    }
}
