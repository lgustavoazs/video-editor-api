import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// O site é servido pela própria API em /app (mesmo endereço: sem CORS e sem chave no navegador).
export default defineConfig({
  base: "/app/",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false, chunkSizeWarningLimit: 4000 },
  server: {
    // Em desenvolvimento: `npm run api` na porta 3000 e `npm run dev -w @video-editor/web`.
    proxy: { "/v1": "http://localhost:3000" },
  },
});
