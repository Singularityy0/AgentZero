import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { argv, env, exit, platform, stderr, stdout } from "node:process";
import { fileURLToPath, URL } from "node:url";
import { rgPath } from "@vscode/ripgrep";

// `@vscode/ripgrep` installs one native binary: the one for the machine running
// the install. There is no cross-platform copy on disk to bundle, so a package
// built for a platform other than the host would ship the wrong executable and
// every file/text search in the shipped app would fail. Refuse instead, and
// build each platform on its own runner (see .github/workflows/release.yml).
const requestedTarget =
  argv[2]?.replace(/^--target=/u, "") ?? env.AGENTIC_BUILD_TARGET ?? platform;

if (requestedTarget !== platform) {
  stderr.write(
    `Refusing to prepare runtime assets for "${requestedTarget}" on "${platform}".\n` +
      "The bundled ripgrep binary is platform-specific and only the host's copy " +
      "is installed, so a cross-built package would ship an unusable binary.\n" +
      "Build each platform on its own machine or CI runner instead.\n",
  );
  exit(1);
}

const assetDirectory = fileURLToPath(
  new URL("../runtime-assets/", import.meta.url),
);
const binaryName = platform === "win32" ? "rg.exe" : "rg";
const destination = join(assetDirectory, binaryName);

mkdirSync(assetDirectory, { recursive: true });
copyFileSync(rgPath, destination);
chmodSync(destination, 0o755);

stdout.write(`Prepared ripgrep runtime asset: ${destination}\n`);
