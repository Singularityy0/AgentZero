import { fileURLToPath, URL } from "node:url";

const packageRoot = fileURLToPath(new URL(".", import.meta.url)).replaceAll(
  "\\",
  "/",
);

/** @type {import('tailwindcss').Config} */
export default {
  content: [`${packageRoot}index.html`, `${packageRoot}src/**/*.{ts,tsx}`],
  theme: {
    extend: {
      colors: {
        canvas: "#0a0a0a",
        panel: "#111111",
        elevated: "#171717",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "Cascadia Code", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};
