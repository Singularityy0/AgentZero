import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { ProjectIdentity } from "./types.js";

export function createProjectIdentity(root: string): ProjectIdentity {
  const rootPath = realpathSync.native(resolve(root));
  return {
    id: createHash("sha256").update(rootPath).digest("hex").slice(0, 32),
    rootPath,
  };
}

export function sameCanonicalRoot(left: string, right: string): boolean {
  return (
    normalizeIdentityPath(realpathSync.native(resolve(left))) ===
    normalizeIdentityPath(realpathSync.native(resolve(right)))
  );
}

function normalizeIdentityPath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
