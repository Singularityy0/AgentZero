import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { platform, stdout } from "node:process";
import { fileURLToPath, URL } from "node:url";
import { rgPath } from "@vscode/ripgrep";

const assetDirectory = fileURLToPath(
  new URL("../runtime-assets/", import.meta.url),
);
const binaryName = platform === "win32" ? "rg.exe" : "rg";
const destination = join(assetDirectory, binaryName);

mkdirSync(assetDirectory, { recursive: true });
copyFileSync(rgPath, destination);
chmodSync(destination, 0o755);

stdout.write(`Prepared ripgrep runtime asset: ${destination}\n`);
