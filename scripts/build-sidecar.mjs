// Build the Rust sidecar for a development run.
//
// The sidecar backs `analyze_code_structure`, `compute_ast_diff`, and the
// signature-pruning half of context compaction. All three degrade to a readable
// tool error when it is absent, so a missing Rust toolchain must not stop the
// IDE from starting - it should just say what was lost. `pnpm build` and
// `pnpm desktop:package` still fail hard, because a shipped installer without
// the sidecar is a silently reduced product.
import { spawnSync } from "node:child_process";
import { platform, stdout } from "node:process";

// `shell: true` would let the arguments be re-parsed by the shell, so the
// executable name is resolved explicitly instead. Windows needs the .cmd/.exe
// suffix that PATHEXT would otherwise supply.
const cargo = platform === "win32" ? "cargo.exe" : "cargo";
const result = spawnSync(
  cargo,
  ["build", "--manifest-path", "rust/Cargo.toml"],
  {
    stdio: "inherit",
  },
);

if (result.error?.code === "ENOENT") {
  stdout.write(
    "\nCargo was not found, so the Rust sidecar was not built.\n" +
      "The IDE will start without structural code slicing, the AST diff tool, " +
      "and signature pruning during compaction.\n" +
      "Install Rust from https://rustup.rs and re-run to enable them.\n\n",
  );
} else if (result.status !== 0) {
  stdout.write(
    "\nThe Rust sidecar failed to build; starting without it.\n" +
      "Structural slicing, the AST diff tool, and signature pruning are disabled.\n\n",
  );
}
