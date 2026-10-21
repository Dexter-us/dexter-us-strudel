import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [
    {
      name: "strudel-hydra-offline-runtime",
      enforce: "pre",
      transform(source, id) {
        if (!id.replaceAll("\\", "/").includes("/@strudel/repl/dist/hydra-")) {
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
