use std::io::{self, BufRead, Write};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use rust::diff::DiffEngine;
use rust::merkle::{StateSnapshot, StateTree};
use rust::cpg_store::{CpgEdge, CpgNode, CpgSnapshot, CpgStore};
use rust::extract::extract;
use rust::flatcpg::{slice_ast, prune_to_signatures};

#[derive(Deserialize)]
struct RpcRequest {
    id: Value,
    method: String,
    params: Value,
}

#[derive(Serialize)]
struct RpcResponse {
    id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn handle_request(
    req: RpcRequest,
    state_tree: &mut StateTree,
    cpg: &mut CpgStore,
) -> RpcResponse {
    match req.method.as_str() {
        "slice_ast" => {
            let code = req.params.get("code").and_then(|v| v.as_str()).unwrap_or("");
            let ext = req.params.get("ext").and_then(|v| v.as_str()).unwrap_or("");
            let symbols = req.params.get("symbols").and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|v| v.as_str()).map(|s| s.to_string()).collect::<Vec<_>>())
                .unwrap_or_default();
            
            let result_slices = slice_ast(code, ext, &symbols);
            let result = serde_json::json!(result_slices);
            RpcResponse { id: req.id, result: Some(result), error: None }
        }
        "prune_ast" => {
            let code = req.params.get("code").and_then(|v| v.as_str()).unwrap_or("");
            let ext = req.params.get("ext").and_then(|v| v.as_str()).unwrap_or("");
            
            let result_str = prune_to_signatures(code, ext);
            let result = serde_json::json!(result_str);
            RpcResponse { id: req.id, result: Some(result), error: None }
        }
        // Symbol and edge extraction for the languages the TypeScript compiler
        // cannot parse. Returns the same shape the TypeScript extractor emits so
        // the index does not care which side produced a row.
        "extract_symbols" => {
            let code = req.params.get("code").and_then(|v| v.as_str()).unwrap_or("");
            let ext = req.params.get("ext").and_then(|v| v.as_str()).unwrap_or("");
            let extracted = extract(code, ext);
            match serde_json::to_value(extracted) {
                Ok(result) => RpcResponse { id: req.id, result: Some(result), error: None },
                Err(error) => RpcResponse {
                    id: req.id,
                    result: None,
                    error: Some(format!("Serialization failed: {}", error)),
                },
            }
        }
        // Replace a project's code property graph and write it through the WAL.
        "cpg_put" => {
            let project_id = req.params.get("projectId").and_then(|v| v.as_str()).unwrap_or("");
            let directory = req.params.get("dir").and_then(|v| v.as_str()).unwrap_or("");
            let revision = req.params.get("revision").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if project_id.is_empty() || directory.is_empty() {
                return RpcResponse {
                    id: req.id,
                    result: None,
                    error: Some("projectId and dir are required".to_string()),
                };
            }
            let nodes: Vec<CpgNode> = req.params.get("nodes")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            let edges: Vec<CpgEdge> = req.params.get("edges")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            let snapshot = CpgSnapshot { nodes, edges, revision };
            match cpg.put(project_id, std::path::Path::new(directory), snapshot) {
                Ok(count) => RpcResponse {
                    id: req.id,
                    result: Some(serde_json::json!({ "nodes": count })),
                    error: None,
                },
                Err(error) => RpcResponse { id: req.id, result: None, error: Some(error) },
            }
        }
        // Revision of the graph on disk, so a caller can tell whether the
        // persisted copy still matches its index before trusting it.
        "cpg_revision" => {
            let project_id = req.params.get("projectId").and_then(|v| v.as_str()).unwrap_or("");
            let directory = req.params.get("dir").and_then(|v| v.as_str()).unwrap_or("");
            let revision = cpg.load(project_id, std::path::Path::new(directory));
            RpcResponse {
                id: req.id,
                result: Some(serde_json::json!(revision)),
                error: None,
            }
        }
        // Rank symbols by graph proximity to the ones a query already matched.
        "cpg_rank" => {
            let project_id = req.params.get("projectId").and_then(|v| v.as_str()).unwrap_or("");
            let directory = req.params.get("dir").and_then(|v| v.as_str()).unwrap_or("");
            let limit = req.params.get("limit").and_then(|v| v.as_u64()).unwrap_or(24) as usize;
            let seeds: Vec<String> = req.params.get("seeds").and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|v| v.as_str()).map(|s| s.to_string()).collect())
                .unwrap_or_default();
            let ranked = cpg.rank(project_id, std::path::Path::new(directory), &seeds, limit);
            RpcResponse {
                id: req.id,
                result: Some(serde_json::to_value(ranked).unwrap_or(serde_json::json!([]))),
                error: None,
            }
        }
        "compute_diff" => {
            let original = req.params.get("original").and_then(|v| v.as_str()).unwrap_or("");
            let proposal = req.params.get("proposal").and_then(|v| v.as_str()).unwrap_or("");
            
            let diff = DiffEngine::compute_diff(original, proposal);
            RpcResponse { id: req.id, result: Some(serde_json::to_value(diff).unwrap()), error: None }
        }
        // Workspace cycle detection. A task that edits a file, reverts it, and
        // edits it again is making no progress even though every individual
        // step succeeded, which a per-step failure fingerprint cannot see.
        "check_cycle" => {
            let cmd_val = req.params.get("cmd").and_then(|v| v.as_str()).map(|s| s.to_string());
            let exit_code = req.params.get("exit_code").and_then(|v| v.as_i64()).map(|v| v as i32);

            let mut hashes: Vec<[u8; 32]> = Vec::new();
            // Hex digests, one per changed file, in caller-sorted order.
            if let Some(list) = req.params.get("file_hashes").and_then(|v| v.as_array()) {
                for entry in list {
                    if let Some(text) = entry.as_str() {
                        hashes.push(hash_from_hex(text));
                    }
                }
            }
            // Retained so an older caller passing a single byte array still works.
            if let Some(h) = req.params.get("file_hash").and_then(|v| v.as_array()) {
                let mut hash = [0u8; 32];
                for (i, v) in h.iter().enumerate().take(32) {
                    hash[i] = v.as_u64().unwrap_or(0) as u8;
                }
                hashes.push(hash);
            }

            let snapshot = StateSnapshot::new(&hashes, cmd_val.as_deref(), exit_code);
            let cycle = state_tree.push_and_check_cycle(snapshot);
            RpcResponse { id: req.id, result: Some(serde_json::to_value(cycle).unwrap()), error: None }
        }
        "reset_cycles" => {
            state_tree.clear();
            RpcResponse { id: req.id, result: Some(serde_json::json!(true)), error: None }
        }
        _ => {
            RpcResponse { id: req.id, result: None, error: Some("Method not found".to_string()) }
        }
    }
}

/// Fold a hex digest of any length into the fixed 32 bytes a snapshot wants.
fn hash_from_hex(text: &str) -> [u8; 32] {
    let mut hash = [0u8; 32];
    let bytes = text.as_bytes();
    for (index, byte) in bytes.iter().enumerate() {
        hash[index % 32] ^= *byte;
    }
    hash
}

fn main() {
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    let mut state_tree = StateTree::new(10);
    let mut cpg = CpgStore::new();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }

        let req: Result<RpcRequest, _> = serde_json::from_str(&line);
        match req {
            Ok(req) => {
                let res = handle_request(req, &mut state_tree, &mut cpg);
                let res_json = serde_json::to_string(&res).unwrap();
                writeln!(stdout, "{}", res_json).unwrap();
                stdout.flush().unwrap();
            }
            Err(e) => {
                let err_res = serde_json::json!({
                    "error": format!("Parse error: {}", e)
                });
                writeln!(stdout, "{}", err_res).unwrap();
                stdout.flush().unwrap();
            }
        }
    }
}
