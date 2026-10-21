import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [
    {
      name: "strudel-hydra-offline-runtime",
      enforce: "pre",
      transform(source, id) {
        const normalizedId = id.replaceAll("\\", "/");
        if (
          !normalizedId.includes("/@strudel/repl/dist/hydra-") &&
          !normalizedId.includes("/@strudel/hydra/dist/index.mjs")
        ) {
          return null;
        }
        return source.replaceAll(
          "https://unpkg.com/hydra-synth",
          "../vendor/hydra-synth.js",
        );
      },
    },
  ],
  build: {
    target: "esnext",
    sourcemap: false,
    minify: true,
  },
});
