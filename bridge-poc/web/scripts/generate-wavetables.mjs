import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const outputDirectory = path.resolve(here, "../public/wavetables");
const sourceRepository =
  "https://github.com/KristofferKarlAxelEkstrand/AKWF-FREE.git";
const sourceCommit = "8de90bf94376670947369e69de0af6b9fbd19286";
const temporarySource = await mkdtemp(path.join(os.tmpdir(), "akwf-source-"));

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed:\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout.trim();
}

async function resolveSource() {
  if (process.env.AKWF_SOURCE) {
    const sourceRoot = path.resolve(process.env.AKWF_SOURCE);
    const revision = git(["-C", sourceRoot, "rev-parse", "HEAD"]);
    if (revision !== sourceCommit) {
      throw new Error(
        `AKWF_SOURCE must be pinned to ${sourceCommit}, found ${revision}.`,
      );
    }
    return sourceRoot;
  }

  git([
    "clone",
    "--depth",
    "1",
    "--filter=blob:none",
    "--sparse",
    sourceRepository,
    temporarySource,
  ]);
  git(["-C", temporarySource, "fetch", "--depth=1", "origin", sourceCommit]);
  git([
    "-C",
    temporarySource,
    "sparse-checkout",
    "set",
    "--no-cone",
    "/AKWF/**",
    "/LICENSE.md",
  ]);
  git(["-C", temporarySource, "checkout", "--detach", sourceCommit]);
  const revision = git(["-C", temporarySource, "rev-parse", "HEAD"]);
  if (revision !== sourceCommit) {
    throw new Error(`Expected AKWF revision ${sourceCommit}, found ${revision}.`);
  }
  return temporarySource;
}

function makeBankId(directoryName) {
  const suffix = directoryName
    .replace(/^AKWF[_-]?/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `akwf_${suffix || "main"}`;
}

function makeBankLabel(directoryName) {
  const suffix = directoryName.replace(/^AKWF[_-]?/i, "").replace(/[_-]+/g, " ");
  return suffix ? `AKWF ${suffix}` : "AKWF";
}

function parsePcmWave(wav, filePath) {
  if (wav.toString("ascii", 0, 4) !== "RIFF" ||
      wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`Not a RIFF/WAVE file: ${filePath}`);
  }

  let format;
  let dataOffset = -1;
  let dataLength = 0;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const chunk = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (chunk === "fmt ") {
      format = {
        encoding: wav.readUInt16LE(start),
        channels: wav.readUInt16LE(start + 2),
        sampleRate: wav.readUInt32LE(start + 4),
        bitsPerSample: wav.readUInt16LE(start + 14),
      };
    } else if (chunk === "data") {
      dataOffset = start;
      dataLength = size;
      break;
    }
    offset = start + size + (size & 1);
  }

  if (!format || dataOffset < 0 || format.encoding !== 1 ||
      format.bitsPerSample !== 16 || ![1, 2].includes(format.channels)) {
    throw new Error(`Unsupported AKWF WAV format: ${filePath}`);
  }
  const bytesPerSample = format.bitsPerSample / 8;
  const sampleCount = dataLength / (format.channels * bytesPerSample);
  if (!Number.isInteger(sampleCount) || sampleCount !== 600) {
    throw new Error(`Expected 600 samples per channel in ${filePath}.`);
  }
  return { ...format, dataOffset, dataLength, sampleCount };
}

function createMonoWave(source, metadata, channel) {
  const dataLength = metadata.sampleCount * 2;
  const output = Buffer.alloc(44 + dataLength);
  output.write("RIFF", 0);
  output.writeUInt32LE(36 + dataLength, 4);
  output.write("WAVE", 8);
  output.write("fmt ", 12);
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(metadata.sampleRate, 24);
  output.writeUInt32LE(metadata.sampleRate * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write("data", 36);
  output.writeUInt32LE(dataLength, 40);

  for (let index = 0; index < metadata.sampleCount; index += 1) {
    const sampleOffset =
      metadata.dataOffset +
      (index * metadata.channels + channel) * 2;
    output.writeInt16LE(
      source.readInt16LE(sampleOffset),
      44 + index * 2,
    );
  }
  return output;
}

const sourceRoot = await resolveSource();
const sourceWavDirectory = path.join(sourceRoot, "AKWF");
const outputWavDirectory = path.join(outputDirectory, "AKWF");
await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputWavDirectory, { recursive: true });

const categories = (await readdir(sourceWavDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .sort((a, b) => a.name.localeCompare(b.name));
const banks = [];

for (const category of categories) {
  const sourceCategory = path.join(sourceWavDirectory, category.name);
  const outputCategory = path.join(outputWavDirectory, category.name);
  const waveforms = (await readdir(sourceCategory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.wav$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  if (!waveforms.length) continue;

  await mkdir(outputCategory, { recursive: true });
  const publishedWaveforms = [];
  for (const waveform of waveforms) {
    const sourcePath = path.join(sourceCategory, waveform);
    const source = await readFile(sourcePath);
    const metadata = parsePcmWave(source, sourcePath);
    if (metadata.channels === 1) {
      await copyFile(sourcePath, path.join(outputCategory, waveform));
      publishedWaveforms.push(waveform);
      continue;
    }

    const stem = waveform.replace(/\.wav$/i, "");
    for (let channel = 0; channel < metadata.channels; channel += 1) {
      const suffix = channel === 0 ? "L" : "R";
      const monoName = `${stem}_${suffix}.wav`;
      await writeFile(
        path.join(outputCategory, monoName),
        createMonoWave(source, metadata, channel),
      );
      publishedWaveforms.push(monoName);
    }
  }

  banks.push({
    id: makeBankId(category.name),
    label: makeBankLabel(category.name),
    files: publishedWaveforms.map(
      (waveform) =>
        `/wavetables/AKWF/${encodeURIComponent(category.name)}/${encodeURIComponent(waveform)}`,
    ),
  });
}

const waveformCount = banks.reduce((count, bank) => count + bank.files.length, 0);
if (!waveformCount) throw new Error("No AKWF WAV files were found in the source.");

await copyFile(
  path.join(sourceRoot, "LICENSE.md"),
  path.join(outputDirectory, "LICENSE.md"),
);
await writeFile(
  path.join(outputDirectory, "SOURCE-NOTICE.txt"),
  `Adventure Kid Waveforms (AKWF-FREE)\nSource: ${sourceRepository}\nPinned source commit: ${sourceCommit}\nWaveform files are distributed under CC0 1.0 Universal; see LICENSE.md.\nStereo WAV files are split into left and right mono entries so both cycles are selectable.\n`,
);
await writeFile(
  path.join(outputDirectory, "manifest.json"),
  `${JSON.stringify({
    source: "Adventure Kid Waveforms (AKWF-FREE)",
    sourceCommit,
    frameLength: 600,
    waveformCount,
    banks,
  })}\n`,
);
console.log(
  `Packaged ${waveformCount} AKWF single-cycle WAVs across ${banks.length} banks; runtime files are local/offline.`,
);
await rm(temporarySource, { recursive: true, force: true });
