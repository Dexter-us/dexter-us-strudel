# Dexter U.S. Strudel

A private Windows VST3 experiment for live-coding Strudel patterns inside a plugin editor and rendering their sound through the plugin's audio outputs.

## UI direction

- **WebView2:** Strudel's browser-based editor and JavaScript pattern runtime.
- **egui:** native plugin controls and status UI in a separate region from the WebView.
- **No MIDI conversion:** Strudel remains the live-coding language. The WebView should send Strudel-derived pattern events to the plugin through an internal event protocol.

## Audio architecture

The plugin's native audio engine must render the sound in the VST3 process callback and write it to the plugin output buffers. That lets the DAW process the VST3 output through effects inserted after this instrument. Web Audio playback inside WebView2 is not the output path for this mode.

The WebView-to-plugin boundary should carry scheduled Strudel pattern data (for example event time, duration, pitch or sample/synth parameters) into a bounded, real-time-safe queue. The audio callback must not wait on the UI, allocate, or perform WebView calls. A first version should define and support a deliberate subset of Strudel patterns rather than promise full language/audio-engine compatibility.

Host transport sync is a separate feature decision; plugin audio output does not by itself imply host-clock synchronization.

## Milestones

1. Bundle the Strudel editor/runtime and verify pattern evaluation offline in WebView2.
2. Define a small internal pattern-event protocol and safely transfer events to the plugin processor.
3. Render a supported pattern subset in the plugin's native audio engine and verify audio reaches the VST3 output buffers.
4. Add egui controls alongside the WebView; validate resize, focus/input, and WebView lifetime.
5. Test the packaged VST3 in a Windows DAW and confirm a downstream host effect receives its output.

## Status

Architecture brief only. No plugin implementation, audio bridge, or DAW validation is present yet.
