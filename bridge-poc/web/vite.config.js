import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: {
    target: "esnext",
    sourcemap: false,
    minify: false,
  },
});
