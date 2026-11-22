import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Builds the read-only dashboard into dist/ui, which `archangel ui` serves. No runtime network calls (fonts are bundled).
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: { outDir: path.resolve(import.meta.dirname, "../dist/ui"), emptyOutDir: true },
});
