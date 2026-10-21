# Dexter U.S. Strudel

A private Windows VST3 experiment to embed the **full Strudel live-coding environment** and return its sound through the plugin's VST3 outputs.

## Intended architecture

- **WebView2:** run Strudel's full JavaScript runtime and REPL/editor, including its pattern engine, mini-notation, transpiler, and browser-based synth/sampler audio stack.
- **egui:** native plugin controls and status UI in a separate region from the WebView.
- **No MIDI conversion:** preserve Strudel as a live-coding language; do not reduce its program to a MIDI workflow or a hand-picked event subset.

## VST3 audio output

Strudel's Web Audio output must be bridged into the plugin's VST3 output buffers so the DAW can process it through downstream effects. The likely prototype is a Web Audio tap feeding a bounded native audio ring buffer, consumed by the plugin's real-time process callback. The callback must not call WebView2, block, or allocate. WebView playback to the computer's speakers should be disabled in plugin mode to avoid a second, unprocessed copy.

This audio bridge is a feasibility milestone, not yet proven. Measure latency, underruns, sample-rate handling, lifecycle/restart behavior, multiple plugin instances, and Windows DAW compatibility. Host transport synchronization is a separate feature from routing audio through the VST3 outputs.

## Upstream and licensing

Strudel's current source is maintained at [Codeberg](https://codeberg.org/uzu/strudel) and declares **AGPL-3.0-or-later**. This repository pins the upstream source as a Git submodule at e00b6f621655d30bc5f9a3aff0d36b11e2af3f52. Review license compatibility before distributing the runtime with this plugin.

Initialize the source after cloning:

```sh
git submodule update --init --recursive
```

## Milestones

1. Build the pinned complete Strudel runtime locally for WebView2.
2. Prove a Web Audio-to-native audio bridge with a standalone Windows harness.
3. Integrate the bridge into VST3 processing and confirm plugin output reaches a downstream DAW effect.
4. Add egui controls beside the Strudel WebView; validate resize, focus/input, and teardown.
5. Test full packaging and behavior in a Windows DAW.

## Status

The Strudel source is pinned as a submodule. The audio bridge, plugin implementation, and DAW validation are not present yet.
