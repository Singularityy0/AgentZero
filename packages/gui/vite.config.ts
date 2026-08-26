import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  // Vite options for the GUI development server.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
});
