export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
}

export class Explorer {
  private container: HTMLElement;
  private onFileSelected: (path: string) => void;
  private currentPath: string = ".";

  constructor(containerId: string, onFileSelected: (path: string) => void) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Container #${containerId} not found`);
    this.container = el;
    this.onFileSelected = onFileSelected;
  }

  async load(path: string = ".") {
    this.currentPath = path;
    this.container.innerHTML = `<div class="tree-item" style="color: var(--text-muted)">Loading...</div>`;
    try {
      const res = await fetch(`/api/files?path=${encodeURIComponent(path)}`);
      if (!res.ok) throw new Error("Failed to load files");
      const data = await res.json();
      this.render(data.entries);
    } catch (err) {
      this.container.innerHTML = `<div class="tree-item" style="color: var(--diff-remove-text)">Error loading files</div>`;
      console.error(err);
    }
  }

  private render(entries: FileEntry[]) {
    this.container.innerHTML = "";
    if (this.currentPath !== ".") {
      const up = document.createElement("div");
      up.className = "tree-item";
      up.innerHTML = `<span class="tree-item-icon">📁</span> ..`;
      up.onclick = () => {
        const parts = this.currentPath.split(/[/\\]/);
        parts.pop();
        this.load(parts.length > 0 ? parts.join("/") : ".");
      };
      this.container.appendChild(up);
    }

    for (const entry of entries) {
      const item = document.createElement("div");
      item.className = "tree-item";

      const icon = entry.type === "directory" ? "📁" : "📄";
      item.innerHTML = `<span class="tree-item-icon">${icon}</span> ${entry.name}`;

      item.onclick = () => {
        // Remove selection from others
        this.container
          .querySelectorAll(".tree-item")
          .forEach((el) => el.classList.remove("selected"));
        item.classList.add("selected");

        if (entry.type === "directory") {
          this.load(entry.path);
        } else {
          this.onFileSelected(entry.path);
        }
      };
      this.container.appendChild(item);
    }
  }
}
