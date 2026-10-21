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
  registerSynthSounds,
  registerZZFXSounds,
} from "@strudel/webaudio";
import * as core from "@strudel/core";

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
