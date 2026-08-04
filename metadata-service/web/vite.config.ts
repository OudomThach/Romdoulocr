import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // Served under /portal by the Romdoul nginx + Netlify, so the built assets
  // must live at /portal/assets/* (they share the host with the Romdoul SPA,
  // which owns /assets).
  base: "/portal/",
  server: {
    port: 5174,
    proxy: {
      "/api": "http://127.0.0.1:8095",
      "/health": "http://127.0.0.1:8095",
    },
  },
  build: { outDir: "dist" },
});
