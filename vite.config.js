import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname),
  build: {
    lib: {
      entry: path.resolve(__dirname, "src/main.jsx"),
      formats: ["iife"],
      fileName: () => "index.js",
      // REQUIRED for iife/umd builds:
      name: "ExamplePluginReact",
    },
    /**
     * TODO: Uncomment rollupOptions, once configured platfrom to include react deps by default.
     * <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
     * <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
     */
    rollupOptions: {
      // external: ["react", "react-dom"],
      output: {
        inlineDynamicImports: true,
        // Put all non-entry assets (images, fonts, css) under dist/assets/*
        assetFileNames: "assets/[name][extname]",
        // Keep any extra chunks (shouldn't occur with inlineDynamicImports) under assets just in case
        // chunkFileNames: "assets/[name]-[hash].js"
        // globals: {
        //   react: "React",
        //   "react-dom": "ReactDOM",
        // },
      },
    },
    outDir: "dist",
    assetsDir: "assets",
    assetsInlineLimit: 0,
    emptyOutDir: true,
    cssCodeSplit: false,
    copyPublicDir: false, //  prevent Vite from copying the public/ folder to dist/ root
  },
  server: {
    port: 4002,
    origin: "http://localhost:4002",
  },
  preview: {
    port: 8002,
  },
});
