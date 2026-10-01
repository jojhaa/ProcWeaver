import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1422, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  build: { outDir: "dist-process", rollupOptions: { input: "process.html" } },
});
