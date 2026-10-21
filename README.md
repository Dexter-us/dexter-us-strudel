# Dexter U.S. Strudel

A private Windows VST3 experiment to bring the Strudel live-coding environment into a plugin editor.

## UI direction

- **WebView2:** Strudel's browser-based editor and JavaScript pattern runtime.
- **egui:** native plugin controls and status UI, kept in a separate region from the WebView.
- **No MIDI requirement:** Strudel remains the live-coding language; this project does not assume a MIDI conversion workflow.

## Audio boundary

In the first prototype, Strudel uses Web Audio inside WebView2. That audio is not automatically routed through the VST3's output and does not automatically follow the DAW host clock. Treat host audio routing and transport sync as separate future design decisions, not as assumed features.

## Milestones

1. Prove the bundled Strudel runtime can load offline in a standalone WebView2 test window.
2. Embed that WebView as a child region alongside egui-native controls in the plugin editor.
3. Validate editor resize, focus/input handling, WebView lifetime, and packaging in a Windows DAW.
4. Decide separately whether browser audio is sufficient or whether a native audio bridge is needed.

## Status

Repository initialized with this architecture brief. No plugin implementation or DAW validation is present yet.
