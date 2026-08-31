import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Vite options for the GUI development server.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    proxy: {
      // The settings/API bridge (packages/gui-server) runs as its own Node
      // process - start it separately with `pnpm settings` or
      // `node packages/gui-server/dist/cli.js`. This proxy only applies to
      // `vite dev`; the built GUI is served directly by gui-server instead.
      "/api": {
        target: "http://127.0.0.1:4737",
        changeOrigin: true,
      },
    },
  },
});
