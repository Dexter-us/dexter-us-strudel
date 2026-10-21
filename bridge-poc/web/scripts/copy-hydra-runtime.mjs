import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const hydraBundle = require.resolve("hydra-synth");
const hydraPackageRoot = resolve(dirname(hydraBundle), "..");
const strudelPackageRoot = dirname(
  require.resolve("@strudel/repl/package.json"),
);
const publicVendorDir = fileURLToPath(
  new URL("../public/vendor/", import.meta.url),
);

await mkdir(publicVendorDir, { recursive: true });
await copyFile(
  hydraBundle,
  resolve(publicVendorDir, "hydra-synth.js"),
);
await copyFile(
  resolve(hydraPackageRoot, "LICENSE"),
  resolve(publicVendorDir, "HYDRA-SYNTH-LICENSE.txt"),
);
await copyFile(
  resolve(strudelPackageRoot, "LICENSE"),
  resolve(publicVendorDir, "STRUDEL-AGPL-3.0.txt"),
);

console.log(
  "Copied the pinned Hydra runtime and Hydra/Strudel license notices into public/vendor.",
);
