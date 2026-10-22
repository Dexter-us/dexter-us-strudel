/*
 * Based on @strudel/repl 1.3.0 prebake.mjs.
 * Copyright (C) 2022 Strudel contributors.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This build registers Strudel's built-in synths without fetching sample maps
 * or soundfonts. Local sample folders are registered by main.js.
 */
import { noteToMidi, valueToMidi, Pattern, evalScope } from "@strudel/core";
import {
  registerWaveTable,
  registerSynthSounds,
  registerZZFXSounds,
} from "@strudel/webaudio";
import * as core from "@strudel/core";
import { registerBuiltInWavetables } from "./wavetable-bank.js";

const userPrebakeStorageKey = "dexter-us-strudel-prebake-v1";

async function loadUserPrebake() {
  try {
    await window.__dexterPortablePrebakePromise;
  } catch {
    // Continue with profile storage or the bundled default if native loading fails.
  }

  if (typeof window.__dexterPortablePrebakeSource === "string") {
    window.__dexterStrudelPrebakeSourceKind = "portable";
    return window.__dexterPortablePrebakeSource;
  }

  try {
    const saved = window.localStorage.getItem(userPrebakeStorageKey);
    if (saved !== null) {
      window.__dexterStrudelPrebakeSourceKind = "profile";
      return saved;
    }
  } catch {
    // Fall back to the bundled file when browser storage is disabled.
  }

  try {
    const response = await fetch(new URL("/prebake.strudel", window.location.href), {
      cache: "no-store",
    });
    if (response.ok) {
      window.__dexterStrudelPrebakeSourceKind = "packaged";
      return await response.text();
    }
  } catch (error) {
    console.warn("Could not load the bundled Prebake file", error);
  }
  window.__dexterStrudelPrebakeSourceKind = "packaged";
  return "";
}

function executeUserPrebake(source) {
  globalThis.__dexterStrudelPrebakeError = "";
  globalThis.__dexterStrudelPrebakeSource = source;
  if (!source.trim()) return;
  try {
    (0, eval)(`${source}\n//# sourceURL=prebake.strudel`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    globalThis.__dexterStrudelPrebakeError = message;
    console.error("Prebake file could not be evaluated", error);
  }
}

export async function prebake() {
  const modulesLoading = evalScope(
    core,
    import("@strudel/draw"),
    import("@strudel/mini"),
    import("@strudel/tonal"),
    import("@strudel/webaudio"),
    import("@strudel/codemirror"),
    import("@strudel/hydra"),
    import("@strudel/soundfonts"),
    import("@strudel/midi"),
  );

  await Promise.all([
    modulesLoading,
    registerSynthSounds(),
    registerZZFXSounds(),
  ]);
  registerBuiltInWavetables(registerWaveTable);

  const userSource = await loadUserPrebake();
  executeUserPrebake(userSource);
}

const maxPan = noteToMidi("C8");
const panwidth = (pan, width) => pan * width + (1 - width) / 2;

Pattern.prototype.piano = function () {
  return this.fmap((value) => ({ ...value, clip: value.clip ?? 1 }))
    .s("piano")
    .release(0.1)
    .fmap((value) => {
      const midi = valueToMidi(value);
      const pan = panwidth(Math.min(Math.round(midi) / maxPan, 1), 0.5);
      return { ...value, pan: (value.pan || 1) * pan };
    });
};
