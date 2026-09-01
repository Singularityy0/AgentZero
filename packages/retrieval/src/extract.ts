import ts from "typescript";
import type {
  ExtractedFile,
  IndexedEdge,
  IndexedSymbol,
  RetrievalEdgeKind,
} from "./types.js";

interface MutableEdge extends IndexedEdge {
  moduleSpecifier?: string;
}

interface ImportedBinding {
  importedName: string;
  moduleSpecifier: string;
}

/**
 * The TypeScript compiler parses JavaScript with the same API, so plain `.js`
 * and `.jsx` sources get real symbol, import, export, and call edges instead of
 * falling back to line regexes. Picking the right `ScriptKind` matters: JSX in a
 * `.js` file only parses under `ScriptKind.JSX`.
 */
function scriptKindFor(path: string): ts.ScriptKind {
  const lowered = path.toLowerCase();
  if (lowered.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (lowered.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (
    lowered.endsWith(".js") ||
    lowered.endsWith(".mjs") ||
    lowered.endsWith(".cjs")
  ) {
    // A `.js` file may legally contain JSX; TSX/JSX parsing is a superset of
    // plain JS for everything this extractor reads.
    return ts.ScriptKind.JSX;
  }
  return ts.ScriptKind.TS;
}

export function extractTypeScript(
  path: string,
  content: string,
): ExtractedFile {
  const source = ts.createSourceFile(
    path,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(path),
  );
  const symbols: IndexedSymbol[] = [];
  const declarationPositions = new Set<number>();
  const imports = new Map<string, ImportedBinding>();
  const edges: MutableEdge[] = [];

  const addSymbol = (
    node: ts.Node,
    nameNode: ts.Identifier | ts.StringLiteral,
    kind: string,
  ): void => {
    declarationPositions.add(nameNode.getStart(source));
    const span = lineSpan(source, node);
    const symbol: IndexedSymbol = {
      name: nameNode.text,
      kind,
      ...span,
      exported: isExported(node),
      signature: compactSignature(node.getText(source)),
    };
    symbols.push(symbol);
    edges.push({
      kind: "definition",
      sourceSymbol: ownerName(symbols, span.startLine, symbol.name),
      targetPath: path,
      targetName: symbol.name,
      line: span.startLine,
    });
    if (symbol.exported) {
      edges.push({
        kind: "export",
        sourceSymbol: symbol.name,
        targetPath: path,
        targetName: symbol.name,
        line: span.startLine,
      });
    }
  };

  const collectDeclarations = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      addSymbol(node, node.name, "function");
    } else if (ts.isClassDeclaration(node) && node.name) {
      addSymbol(node, node.name, "class");
    } else if (ts.isInterfaceDeclaration(node)) {
      addSymbol(node, node.name, "interface");
    } else if (ts.isTypeAliasDeclaration(node)) {
      addSymbol(node, node.name, "type");
    } else if (ts.isEnumDeclaration(node)) {
      addSymbol(node, node.name, "enum");
    } else if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) {
      addSymbol(node, node.name, "namespace");
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      addSymbol(node, node.name, variableKind(node));
    } else if (ts.isMethodDeclaration(node) && isNamedDeclaration(node.name)) {
      addSymbol(node, node.name, "method");
    } else if (
      ts.isPropertyDeclaration(node) &&
      isNamedDeclaration(node.name)
    ) {
      addSymbol(node, node.name, "property");
    } else if (
      (ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)) &&
      isNamedDeclaration(node.name)
    ) {
      addSymbol(node, node.name, "accessor");
    }
    ts.forEachChild(node, collectDeclarations);
  };
  collectDeclarations(source);

  const collectImportsAndExports = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const moduleSpecifier = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (clause?.name) {
        declarationPositions.add(clause.name.getStart(source));
        imports.set(clause.name.text, {
          importedName: "default",
          moduleSpecifier,
        });
        addModuleEdge(
          edges,
          "import",
          clause.name.text,
          "default",
          moduleSpecifier,
          lineOf(source, node),
        );
      }
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        const local = clause.namedBindings.name;
        declarationPositions.add(local.getStart(source));
        imports.set(local.text, {
          importedName: "*",
          moduleSpecifier,
        });
        addModuleEdge(
          edges,
          "import",
          local.text,
          "*",
          moduleSpecifier,
          lineOf(source, node),
        );
      } else if (
        clause?.namedBindings &&
        ts.isNamedImports(clause.namedBindings)
      ) {
        for (const element of clause.namedBindings.elements) {
          const importedName = (element.propertyName ?? element.name).text;
          declarationPositions.add(element.name.getStart(source));
          if (element.propertyName) {
            declarationPositions.add(element.propertyName.getStart(source));
          }
          imports.set(element.name.text, { importedName, moduleSpecifier });
          addModuleEdge(
            edges,
            "import",
            element.name.text,
            importedName,
            moduleSpecifier,
            lineOf(source, element),
          );
        }
      }
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const moduleSpecifier = node.moduleSpecifier.text;
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          addModuleEdge(
            edges,
            "export",
            undefined,
            (element.propertyName ?? element.name).text,
            moduleSpecifier,
            lineOf(source, element),
          );
        }
      } else {
        addModuleEdge(
          edges,
          "export",
          undefined,
          "*",
          moduleSpecifier,
          lineOf(source, node),
        );
      }
    }
    ts.forEachChild(node, collectImportsAndExports);
  };
  collectImportsAndExports(source);

  const localDefinitions = new Set(symbols.map((symbol) => symbol.name));
  const seen = new Set<string>();
  const collectUsages = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const call = calledName(node.expression);
      if (call) {
        const imported = importedCall(node.expression, imports);
        addUniqueEdge(seen, edges, {
          kind: "call",
          sourceSymbol: containingSymbol(symbols, lineOf(source, node)),
          targetPath: imported ? undefined : path,
          targetName: imported?.importedName ?? call,
          line: lineOf(source, node),
          moduleSpecifier: imported?.moduleSpecifier,
        });
      }
    }
    if (
      ts.isIdentifier(node) &&
      !declarationPositions.has(node.getStart(source)) &&
      isReferenceIdentifier(node)
    ) {
      const imported = imports.get(node.text);
      if (imported || localDefinitions.has(node.text)) {
        addUniqueEdge(seen, edges, {
          kind: "reference",
          sourceSymbol: containingSymbol(symbols, lineOf(source, node)),
          targetPath: imported ? undefined : path,
          targetName: imported?.importedName ?? node.text,
          line: lineOf(source, node),
          moduleSpecifier: imported?.moduleSpecifier,
        });
      }
    }
    ts.forEachChild(node, collectUsages);
  };
  collectUsages(source);

  return { symbols, edges };
}

export function extractTextMetadata(content: string): ExtractedFile {
  const symbols: IndexedSymbol[] = [];
  const edges: IndexedEdge[] = [];
  const definition =
    /^\s*(?:(?:public|private|protected|static|export|async)\s+)*(def|class|function|fn|func|struct|enum|interface|trait|type)\s+([A-Za-z_$][\w$]*)/;
  const importPattern =
    /^\s*(?:from\s+([\w./-]+)\s+import|import\s+([\w./-]+)|use\s+([\w:]+)|#include\s+[<"]([^>"]+))/;
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const match = definition.exec(line);
    if (match?.[2]) {
      symbols.push({
        name: match[2],
        kind: `text-${match[1] ?? "definition"}`,
        startLine: index + 1,
        endLine: index + 1,
        exported: /\b(?:public|export)\b/.test(line),
        signature: line.trim().slice(0, 180),
      });
      edges.push({
        kind: "definition",
        targetName: match[2],
        line: index + 1,
      });
    }
    const imported = importPattern.exec(line);
    const moduleSpecifier = imported?.slice(1).find(Boolean);
    if (moduleSpecifier) {
      edges.push({
        kind: "import",
        targetName:
          moduleSpecifier.split(/[/:]/).filter(Boolean).at(-1) ??
          moduleSpecifier,
        line: index + 1,
        moduleSpecifier,
      });
    }
  }
  return { symbols, edges };
}

function addModuleEdge(
  edges: MutableEdge[],
  kind: Extract<RetrievalEdgeKind, "import" | "export">,
  sourceSymbol: string | undefined,
  targetName: string,
  moduleSpecifier: string,
  line: number,
): void {
  edges.push({ kind, sourceSymbol, targetName, moduleSpecifier, line });
}

function addUniqueEdge(
  seen: Set<string>,
  edges: MutableEdge[],
  edge: MutableEdge,
): void {
  const key = [
    edge.kind,
    edge.sourceSymbol,
    edge.targetName,
    edge.line,
    edge.moduleSpecifier,
  ].join("\u0000");
  if (seen.has(key)) return;
  seen.add(key);
  edges.push(edge);
}

function importedCall(
  expression: ts.LeftHandSideExpression,
  imports: Map<string, ImportedBinding>,
): ImportedBinding | undefined {
  if (ts.isIdentifier(expression)) return imports.get(expression.text);
  if (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression)
  ) {
    const namespace = imports.get(expression.expression.text);
    return namespace
      ? {
          importedName: expression.name.text,
          moduleSpecifier: namespace.moduleSpecifier,
        }
      : undefined;
  }
  return undefined;
}

function calledName(expression: ts.LeftHandSideExpression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression &&
    ts.isStringLiteral(expression.argumentExpression)
  ) {
    return expression.argumentExpression.text;
  }
  return undefined;
}

function isReferenceIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node)
    return false;
  if (
    (ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent))
    return false;
  return true;
}

function isNamedDeclaration(
  name: ts.PropertyName,
): name is ts.Identifier | ts.StringLiteral {
  return ts.isIdentifier(name) || ts.isStringLiteral(name);
}

function isExported(node: ts.Node): boolean {
  let current: ts.Node | undefined = node;
  while (current && !ts.isSourceFile(current)) {
    if (ts.canHaveModifiers(current)) {
      const modifiers = ts.getModifiers(current);
      if (
        modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
        )
      ) {
        return true;
      }
    }
    if (ts.isVariableDeclaration(current)) current = current.parent.parent;
    else break;
  }
  return false;
}

function variableKind(node: ts.VariableDeclaration): string {
  const list = node.parent;
  if (!ts.isVariableDeclarationList(list)) return "variable";
  if (list.flags & ts.NodeFlags.Const) return "const";
  if (list.flags & ts.NodeFlags.Let) return "let";
  return "var";
}

function lineSpan(
  source: ts.SourceFile,
  node: ts.Node,
): { startLine: number; endLine: number } {
  return {
    startLine: lineOf(source, node),
    endLine: source.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
  };
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function compactSignature(text: string): string {
  return text.replace(/\s+/g, " ").split("{")[0]?.trim().slice(0, 240) ?? "";
}

function containingSymbol(
  symbols: IndexedSymbol[],
  line: number,
): string | undefined {
  return symbols
    .filter((symbol) => symbol.startLine <= line && symbol.endLine >= line)
    .sort(
      (left, right) =>
        left.endLine - left.startLine - (right.endLine - right.startLine),
    )[0]?.name;
}

function ownerName(
  symbols: IndexedSymbol[],
  line: number,
  ownName: string,
): string | undefined {
  return symbols
    .filter(
      (symbol) =>
        symbol.name !== ownName &&
        symbol.startLine <= line &&
        symbol.endLine >= line,
    )
    .at(-1)?.name;
}
