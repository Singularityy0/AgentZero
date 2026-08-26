import * as monaco from "monaco-editor";

import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less")
      return new cssWorker();
    if (label === "html" || label === "handlebars" || label === "razor")
      return new htmlWorker();
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  html: "html",
  css: "css",
  md: "markdown",
  yml: "yaml",
  yaml: "yaml",
  sh: "shell",
  py: "python",
  rs: "rust",
  go: "go",
};

function languageForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return LANGUAGE_BY_EXTENSION[ext] ?? "plaintext";
}

export class Editor {
  private editor: monaco.editor.IStandaloneCodeEditor;
  private container: HTMLElement;
  private models = new Map<string, monaco.editor.ITextModel>();
  private onCursorChange?: (line: number, column: number) => void;
  private onLanguageChange?: (language: string) => void;

  constructor(containerId: string) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Container #${containerId} not found`);
    this.container = el;

    // Create editor with default options
    this.editor = monaco.editor.create(this.container, {
      value: "",
      language: "plaintext",
      theme: "vs-dark",
      automaticLayout: true,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      fontSize: 13,
      fontFamily: "'Space Mono', Consolas, monospace",
      padding: { top: 16 },
      readOnly: true,
    });

    this.editor.onDidChangeCursorPosition((event) => {
      this.onCursorChange?.(event.position.lineNumber, event.position.column);
    });
  }

  onCursorPositionChanged(callback: (line: number, column: number) => void) {
    this.onCursorChange = callback;
  }

  onActiveLanguageChanged(callback: (language: string) => void) {
    this.onLanguageChange = callback;
  }

  async loadFile(path: string) {
    try {
      let model = this.models.get(path);
      if (!model) {
        const res = await fetch(
          `/api/files/content?path=${encodeURIComponent(path)}`,
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => undefined)) as
            { error?: string } | undefined;
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }
        const file = (await res.json()) as { content: string };
        const language = languageForPath(path);
        model = monaco.editor.createModel(
          file.content,
          language,
          monaco.Uri.file(path),
        );
        this.models.set(path, model);
      }
      this.editor.setModel(model);
      this.onLanguageChange?.(model.getLanguageId());
      const position = this.editor.getPosition();
      if (position) this.onCursorChange?.(position.lineNumber, position.column);
    } catch (err) {
      console.error(err);
      const errorModel = monaco.editor.createModel(
        `Could not open ${path}\n\n${err instanceof Error ? err.message : String(err)}`,
        "plaintext",
      );
      this.editor.setModel(errorModel);
    }
  }

  hide() {
    this.container.style.display = "none";
  }

  show() {
    this.container.style.display = "block";
  }
}
