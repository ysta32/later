import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
export default defineConfig({
  plugins: [preact()],
  server: {
    port: 4810,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:4800",
      "/share": "http://localhost:4800",
      "/bookmarklet.js": "http://localhost:4800",
    },
  },
});
