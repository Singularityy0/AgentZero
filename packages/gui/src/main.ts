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

const providersList = document.getElementById(
  "providers-list",
) as HTMLDivElement;
const statusMsg = document.getElementById(
  "vault-status",
) as HTMLParagraphElement;

window.addEventListener("DOMContentLoaded", () => {
  void loadProviders();
});

async function loadProviders(): Promise<void> {
  try {
    const response = await fetch("/api/providers");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { providers: ProviderView[] };
    render(body.providers);
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

function render(providers: ProviderView[]): void {
  providersList.innerHTML = "";
  for (const provider of providers) {
    providersList.appendChild(renderProviderCard(provider));
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
    help.style.fontSize = "0.65rem";
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
  statusMsg.textContent = message;
  statusMsg.style.color = isError
    ? "var(--diff-remove-text)"
    : "var(--diff-add-text)";
}

// Clickable code tokens in the chat/diff panels - wired to the real
// TypeScript workspace/review service in a later phase (manual context
// control). For now this only logs the intent.
document.querySelectorAll(".file-tag").forEach((tag) => {
  tag.addEventListener("click", () => {
    const file = tag.getAttribute("data-file");
    const lines = tag.getAttribute("data-line");
    console.log(`Opening ${file} at lines ${lines}`);
  });
});
