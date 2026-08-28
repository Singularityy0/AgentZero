import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/dist-tests/**",
      "**/node_modules/**",
      "**/tmp/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
);
