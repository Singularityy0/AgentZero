import { Explorer } from "./explorer";
import { Editor } from "./editor";

// --------------------------------------------------------
// Layout & State Initialization
// --------------------------------------------------------

let editor: Editor;
let explorer: Explorer;

document.addEventListener("DOMContentLoaded", () => {
  // Initialize Editor
  editor = new Editor("monaco-container");

  // Hide welcome screen when a file is opened
  const welcomeScreen = document.querySelector(
    ".welcome-screen",
  ) as HTMLElement;
  const statusLine = document.getElementById(
    "status-line-col",
  ) as HTMLSpanElement;
  const statusLanguage = document.getElementById(
    "status-language",
  ) as HTMLSpanElement;
  editor.onCursorPositionChanged((line, column) => {
    statusLine.textContent = `Ln ${line}, Col ${column}`;
  });
  editor.onActiveLanguageChanged((language) => {
    statusLanguage.textContent = language;
  });

  // Initialize Explorer
  explorer = new Explorer("file-tree", (filePath) => {
    welcomeScreen.style.display = "none";
    editor.show();
    void editor.loadFile(filePath);

    // Update active tab
    const tab = document.getElementById("active-file-tab");
    if (tab) {
      tab.textContent = filePath.split(/[/\\]/).pop() || filePath;
    }
  });

  void explorer.load(".");

  // Activity Bar routing
  const actions = document.querySelectorAll(".activity-action");
  actions.forEach((action) => {
    action.addEventListener("click", () => {
      // Toggle active class on actions
      actions.forEach((a) => a.classList.remove("active"));
      action.classList.add("active");

      // Show target view in sidebar
      const target = action.getAttribute("data-target");
      document.querySelectorAll(".sidebar-view").forEach((view) => {
        view.classList.remove("active");
      });
      const view = document.getElementById(`view-${target}`);
      if (view) view.classList.add("active");
    });
  });

  void loadProject();
  void loadProviders();
  setupChat();
});

// --------------------------------------------------------
// Status bar / project info
// --------------------------------------------------------

async function loadProject(): Promise<void> {
  const nameEl = document.getElementById(
    "status-workspace-name",
  ) as HTMLSpanElement;
  const connectionEl = document.getElementById(
    "status-connection",
  ) as HTMLSpanElement;
  try {
    const response = await fetch("/api/project");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { name: string };
    nameEl.textContent = body.name;
    connectionEl.textContent = "Connected";
  } catch {
    nameEl.textContent = "No workspace";
    connectionEl.textContent = 'Disconnected - start with "pnpm settings"';
  }
}

// --------------------------------------------------------
// AI Chat (preview only - not yet wired to the agent runtime)
// --------------------------------------------------------

function setupChat(): void {
  const input = document.getElementById("chat-input") as HTMLInputElement;
  const history = document.getElementById("chat-history") as HTMLDivElement;
  if (!input || !history) return;

  appendChatMessage(
    history,
    "system",
    "Preview UI - this chat is not yet connected to the agent runtime. " +
      "Messages you send here are only shown locally.",
  );

  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || !input.value.trim()) return;
    appendChatMessage(history, "user", input.value.trim());
    input.value = "";
  });
}

function appendChatMessage(
  container: HTMLDivElement,
  role: "user" | "system",
  text: string,
): void {
  const bubble = document.createElement("div");
  bubble.className = `chat-message chat-message-${role}`;
  bubble.textContent = text;
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
}

// --------------------------------------------------------
// Provider Settings Logic (Retained from original main.ts)
// --------------------------------------------------------

interface ProviderView {
  id: string;
  label: string;
  fields: Array<"apiKey" | "baseUrl" | "manualModelId">;
  credentialRequired: boolean;
  helpUrl?: string;
  hasCredential: boolean;
  maskedCredential?: string;
  baseUrl?: string;
  manualModelId?: string;
  lastValidation?: { ok: boolean; message?: string; at: number };
}

async function loadProviders(): Promise<void> {
  const providersList = document.getElementById(
    "providers-list",
  ) as HTMLDivElement;
  try {
    const response = await fetch("/api/providers");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { providers: ProviderView[] };
    renderProviders(body.providers, providersList);
  } catch (error) {
    providersList.innerHTML = "";
    showStatus(
      `Could not reach the settings server: ${
        error instanceof Error ? error.message : String(error)
      }. Start it with "pnpm settings".`,
      true,
    );
  }
}

function renderProviders(
  providers: ProviderView[],
  container: HTMLDivElement,
): void {
  container.innerHTML = "";
  for (const provider of providers) {
    container.appendChild(renderProviderCard(provider));
  }
}

function renderProviderCard(provider: ProviderView): HTMLDivElement {
  const card = document.createElement("div");
  card.className = "provider-card";
  card.dataset.providerId = provider.id;

  const header = document.createElement("div");
  header.className = "provider-card-header";
  const name = document.createElement("span");
  name.className = "provider-name";
  name.textContent = provider.label;
  header.appendChild(name);
  header.appendChild(renderStatusBadge(provider));
  card.appendChild(header);

  if (provider.helpUrl) {
    const help = document.createElement("a");
    help.href = provider.helpUrl;
    help.target = "_blank";
    help.rel = "noreferrer";
    help.style.fontSize = "10px";
    help.style.color = "var(--text-muted)";
    help.textContent = "Get an API key ->";
    card.appendChild(help);
  }

  const inputs: Record<string, HTMLInputElement> = {};

  if (provider.fields.includes("apiKey")) {
    const group = document.createElement("div");
    group.className = "input-group";
    const label = document.createElement("label");
    label.textContent = provider.credentialRequired
      ? "API Key (required)"
      : "API Key (optional)";
    const input = document.createElement("input");
    input.type = "password";
    input.className = "vault-input";
    input.placeholder = provider.hasCredential
      ? `Set (${provider.maskedCredential}) - leave blank to keep`
      : "Not set";
    inputs.apiKey = input;
    group.append(label, input);
    card.appendChild(group);
  }

  if (provider.fields.includes("baseUrl")) {
    const group = document.createElement("div");
    group.className = "input-group";
    const label = document.createElement("label");
    label.textContent = "Base URL";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "vault-input";
    input.placeholder = "http://localhost:11434";
    input.value = provider.baseUrl ?? "";
    inputs.baseUrl = input;
    group.append(label, input);
    card.appendChild(group);
  }

  if (provider.fields.includes("manualModelId")) {
    const group = document.createElement("div");
    group.className = "input-group";
    const label = document.createElement("label");
    label.textContent = "Model ID";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "vault-input";
    input.value = provider.manualModelId ?? "";
    inputs.manualModelId = input;
    group.append(label, input);
    card.appendChild(group);
  }

  const actions = document.createElement("div");
  actions.className = "provider-actions";

  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.className = "btn-primary";
  saveButton.textContent = "Save";
  saveButton.addEventListener("click", () => {
    void saveProvider(provider.id, inputs);
  });
  actions.appendChild(saveButton);

  const validateButton = document.createElement("button");
  validateButton.type = "button";
  validateButton.className = "btn-secondary";
  validateButton.textContent = "Validate";
  validateButton.addEventListener("click", () => {
    void validateProvider(provider.id);
  });
  actions.appendChild(validateButton);

  if (provider.hasCredential || provider.baseUrl || provider.manualModelId) {
    const clearButton = document.createElement("button");
    clearButton.type = "button";
    clearButton.className = "btn-secondary";
    clearButton.textContent = "Clear";
    clearButton.addEventListener("click", () => {
      void clearProvider(provider.id);
    });
    actions.appendChild(clearButton);
  }

  card.appendChild(actions);
  return card;
}

function renderStatusBadge(provider: ProviderView): HTMLSpanElement {
  const badge = document.createElement("span");
  if (provider.lastValidation) {
    badge.className = `status-badge ${provider.lastValidation.ok ? "ok" : "fail"}`;
    badge.textContent = provider.lastValidation.ok ? "Validated" : "Failed";
    badge.title = provider.lastValidation.message ?? "";
  } else if (provider.hasCredential || !provider.credentialRequired) {
    badge.className = "status-badge unset";
    badge.textContent = "Not validated";
  } else {
    badge.className = "status-badge unset";
    badge.textContent = "Not configured";
  }
  return badge;
}

async function saveProvider(
  providerId: string,
  inputs: Record<string, HTMLInputElement>,
): Promise<void> {
  const body: Record<string, string> = {};
  if (inputs.apiKey && inputs.apiKey.value) body.apiKey = inputs.apiKey.value;
  if (inputs.baseUrl) body.baseUrl = inputs.baseUrl.value;
  if (inputs.manualModelId) body.manualModelId = inputs.manualModelId.value;
  try {
    const response = await fetch(`/api/providers/${providerId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    showStatus(`Saved settings for ${providerId}.`, false);
    await loadProviders();
  } catch (error) {
    showStatus(
      `Failed to save ${providerId}: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }
}

async function clearProvider(providerId: string): Promise<void> {
  try {
    const response = await fetch(`/api/providers/${providerId}`, {
      method: "DELETE",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    showStatus(`Cleared settings for ${providerId}.`, false);
    await loadProviders();
  } catch (error) {
    showStatus(
      `Failed to clear ${providerId}: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }
}

async function validateProvider(providerId: string): Promise<void> {
  showStatus(`Validating ${providerId}...`, false);
  try {
    const response = await fetch(`/api/providers/${providerId}/validate`, {
      method: "POST",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as {
      result: { ok: boolean; message?: string };
    };
    showStatus(
      body.result.ok
        ? `${providerId} credentials are valid.`
        : `${providerId} validation failed: ${body.result.message ?? "unknown error"}`,
      !body.result.ok,
    );
    await loadProviders();
  } catch (error) {
    showStatus(
      `Failed to validate ${providerId}: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }
}

function showStatus(message: string, isError: boolean): void {
  const statusMsg = document.getElementById(
    "vault-status",
  ) as HTMLParagraphElement;
  if (!statusMsg) return;
  statusMsg.textContent = message;
  statusMsg.style.color = isError ? "#f85149" : "#3fb950";
}
