// DOM Elements
const vaultForm = document.getElementById("vault-form") as HTMLFormElement;
const groqInput = document.getElementById("groq-key") as HTMLInputElement;
const geminiInput = document.getElementById("gemini-key") as HTMLInputElement;
const cerebrasInput = document.getElementById(
  "cerebras-key",
) as HTMLInputElement;
const statusMsg = document.getElementById(
  "vault-status",
) as HTMLParagraphElement;

// Load existing keys (mocked from localStorage for now, later passed to Rust/WAL)
window.addEventListener("DOMContentLoaded", () => {
  groqInput.value = localStorage.getItem("rigza_groq_key") || "";
  geminiInput.value = localStorage.getItem("rigza_gemini_key") || "";
  cerebrasInput.value = localStorage.getItem("rigza_cerebras_key") || "";
});

vaultForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  // Persist keys securely (simulated via local storage for UI scaffold)
  localStorage.setItem("rigza_groq_key", groqInput.value);
  localStorage.setItem("rigza_gemini_key", geminiInput.value);
  localStorage.setItem("rigza_cerebras_key", cerebrasInput.value);

  statusMsg.textContent = "Keys securely saved to Vault.";
  statusMsg.style.opacity = "1";

  setTimeout(() => {
    statusMsg.style.opacity = "0";
  }, 3000);
});

// Clickable Code Tokens
document.querySelectorAll(".file-tag").forEach((tag) => {
  tag.addEventListener("click", () => {
    const file = tag.getAttribute("data-file");
    const lines = tag.getAttribute("data-line");
    console.log(`Opening ${file} at lines ${lines}`);
    // In full implementation, this will send an IPC message to Rust/Tauri to focus the file
  });
});

// Example IPC call to the Rust backend
// Uncomment when ready to test IPC
/*
async function triggerDiff() {
  const diffs = await invoke("compute_diff", { original: "foo", proposal: "bar" });
  console.log(diffs);
}
*/
