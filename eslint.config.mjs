import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/dist-tests/**",
      "**/node_modules/**",
      "**/release/**",
      "**/tmp/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Sandboxed Electron preload scripts must be CommonJS - see the comment
    // at the top of preload.cjs for why this can't be a compiled .ts file.
    files: ["**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        require: "readonly",
        module: "readonly",
        exports: "writable",
        process: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
