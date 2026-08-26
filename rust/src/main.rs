use std::io::{self, BufRead, Write};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use rust::diff::DiffEngine;
use rust::merkle::{StateSnapshot, StateTree};
use rust::flatcpg::slice_ast;

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

fn handle_request(req: RpcRequest, state_tree: &mut StateTree) -> RpcResponse {
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
        "compute_diff" => {
            let original = req.params.get("original").and_then(|v| v.as_str()).unwrap_or("");
            let proposal = req.params.get("proposal").and_then(|v| v.as_str()).unwrap_or("");
            
            let diff = DiffEngine::compute_diff(original, proposal);
            RpcResponse { id: req.id, result: Some(serde_json::to_value(diff).unwrap()), error: None }
        }
        "check_cycle" => {
            let cmd_val = req.params.get("cmd").and_then(|v| v.as_str()).map(|s| s.to_string());
            
            let mut hash = [0u8; 32];
            if let Some(h) = req.params.get("file_hash").and_then(|v| v.as_array()) {
                for (i, v) in h.iter().enumerate().take(32) {
                    hash[i] = v.as_u64().unwrap_or(0) as u8;
                }
            }

            let snapshot = StateSnapshot::new(&[hash], cmd_val.as_deref(), None);
            let cycle = state_tree.push_and_check_cycle(snapshot);
            RpcResponse { id: req.id, result: Some(serde_json::to_value(cycle).unwrap()), error: None }
        }
        _ => {
            RpcResponse { id: req.id, result: None, error: Some("Method not found".to_string()) }
        }
    }
}

fn main() {
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    let mut state_tree = StateTree::new(10);

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
                let res = handle_request(req, &mut state_tree);
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
