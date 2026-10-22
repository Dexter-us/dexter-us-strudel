import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outputDirectory = path.resolve(here, "../public/wavetables");
const frameLength = 2048;
const frameCount = 16;
const sampleRate = 44100;

const tables = [
  ["dx_saw", saw],
  ["dx_square", square],
  ["dx_triangle", triangle],
  ["dx_bright", bright],
  ["dx_hollow", hollow],
  ["dx_glass", glass],
];

function saw(harmonic) {
  return (harmonic % 2 === 0 ? -1 : 1) / harmonic;
}

function square(harmonic) {
  return harmonic % 2 === 1 ? 1 / harmonic : 0;
}

function triangle(harmonic) {
  if (harmonic % 2 === 0) return 0;
  return (Math.floor((harmonic - 1) / 2) % 2 === 0 ? 1 : -1) /
    (harmonic * harmonic);
}

function bright(harmonic) {
  return (harmonic % 3 === 0 ? -1 : 1) / Math.sqrt(harmonic);
}

function hollow(harmonic) {
  if (harmonic === 1) return 0.7;
  return harmonic % 3 === 0 ? 1.2 / harmonic : 0.15 / harmonic;
}

function glass(harmonic) {
  const formant = Math.exp(-((harmonic - 6) ** 2) / 9);
  return (harmonic % 2 === 0 ? -1 : 1) * (0.25 / harmonic + formant);
}

function makeWav(getHarmonicWeight) {
  const pcmBytes = frameLength * frameCount * 2;
  const wav = Buffer.alloc(44 + pcmBytes);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + pcmBytes, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // mono
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(pcmBytes, 40);

  for (let frame = 0; frame < frameCount; frame += 1) {
    const maxHarmonic =
      1 + Math.floor((frame / (frameCount - 1)) * 31);
    const samples = new Float64Array(frameLength);
    let peak = 0;

    for (let index = 0; index < frameLength; index += 1) {
      const phase = (2 * Math.PI * index) / frameLength;
      let value = 0;
      for (let harmonic = 1; harmonic <= maxHarmonic; harmonic += 1) {
        value += getHarmonicWeight(harmonic) *
          Math.sin(phase * harmonic);
      }
      samples[index] = value;
      peak = Math.max(peak, Math.abs(value));
    }

    const frameOffset = 44 + frame * frameLength * 2;
    const scale = peak > 0 ? 0.88 * 32767 / peak : 0;
    for (let index = 0; index < frameLength; index += 1) {
      const sample = Math.max(
        -32768,
        Math.min(32767, Math.round(samples[index] * scale)),
      );
      wav.writeInt16LE(sample, frameOffset + index * 2);
    }
  }
  return wav;
}

await mkdir(outputDirectory, { recursive: true });
for (const [name, getHarmonicWeight] of tables) {
  await writeFile(
    path.join(outputDirectory, `${name}.wav`),
    makeWav(getHarmonicWeight),
  );
}
console.log(`Generated ${tables.length} offline procedural wavetables.`);
