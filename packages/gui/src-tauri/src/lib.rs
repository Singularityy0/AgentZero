use rust::diff::{DiffChunk, DiffEngine};
use rust::merkle::{StateSnapshot, StateTree};
use std::sync::Mutex;
use tauri::State;

// Simple state to hold our merkle tree
struct AppState {
    pub state_tree: Mutex<StateTree>,
}

#[tauri::command]
async fn slice_ast(_code: String, _symbols: Vec<String>) -> Result<Vec<String>, String> {
    // In a real implementation this would invoke FlatCPG PPR slicing.
    // We simulate returning relevant lines/symbols.
    Ok(vec!["sliced_result_stub".to_string()])
}

#[tauri::command]
async fn compute_diff(_original: String, _proposal: String) -> Result<Vec<DiffChunk>, String> {
    // Calls Zhang-Shasha diff engine
    Ok(DiffEngine::compute_diff(&(), &()))
}

#[tauri::command]
async fn check_cycle(
    state: State<'_, AppState>,
    _file_hash: [u8; 32],
    cmd: Option<String>,
) -> Result<Option<usize>, String> {
    let snapshot = StateSnapshot::new(&[[0; 32]], cmd.as_deref(), None); // stub file hashes for now
    let mut tree = state.state_tree.lock().unwrap();
    Ok(tree.push_and_check_cycle(snapshot))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            state_tree: Mutex::new(StateTree::new(10)),
        })
        .invoke_handler(tauri::generate_handler![slice_ast, compute_diff, check_cycle])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
