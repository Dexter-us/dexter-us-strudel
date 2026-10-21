# Dexter U.S. Strudel VST3

This page uses Strudel's published packages and a small local REPL wrapper. It
keeps the Strudel pattern language, synths, buses, and effects, and redirects
only the final Superdough output into an `AudioWorkletNode`. Startup registers
the built-in synths but does not fetch sample maps or soundfonts.

The WebView2 host is implemented by the Windows VST3 editor in
`../native/vst3/StrudelEditorView.cpp`:

1. Create a read/write `ICoreWebView2SharedBuffer` with a 64-byte header and a
   stereo float ring buffer.
2. Initialize the little-endian header:
   - `0`: magic `0x53425247` (`SBRG`)
   - `4`: protocol version `1`
   - `8`: channels (`2`)
   - `12`: ring capacity in frames
   - `16`: producer frame counter (initially `0`)
   - `20`: host sample rate
3. Share the buffer with `PostSharedBufferToScript`, using JSON additional data
   such as `{"sampleRate":48000}`.
4. Handle `{ "type": "request-audio-buffer" }` by posting the shared buffer.
5. Handle `{ "type": "audio-ready", "writeFrame": N }` on the WebView2 UI
   thread, publish `N` to a lock-free native state, and let the VST3 audio
   callback consume only already-published frames.

The worklet writes interleaved stereo float32 frames into the shared ring and
notifies the UI thread every 512 frames. It does not send PCM arrays as JSON.
The VST3 callback outputs silence on underrun and never calls WebView2, waits
for the renderer, allocates, or takes a UI-thread lock. The Web Audio context
requests the silent `sinkId` so playback is intended to leave only through the
VST3 output bus.

The VST3 component saves the editor's UTF-8 Strudel code through both the
processor component-state interface and the edit-controller state interface.
CodeMirror changes are sent to the native component, and restored code is
returned to the WebView before the editor mounts. This makes the pattern travel
with host-saved VST3 state, where supported by the host's bank/project save.
The editor also writes code to the persistent WebView2 profile on each edit, so
closing and reopening the editor window in the same instance does not depend on
the host saving a bank.

Sample audio can be loaded from a folder beside the VST3 bundle. The default
portable layout is:

```text
DexterUSStrudel.vst3/
├── Contents/
└── uzu-drumkit-main/
```

The plugin auto-discovers `Samples`, `samples`, or `uzu-drumkit-main` beside
`Contents`. Choose Sample Folder can also select another folder. If that folder
is inside the VST3 bundle, its relative path is saved beside `Contents`, so
moving the whole folder keeps the library attached. An external folder works
only for the current session; move it into the bundle for a portable setup.
The plugin indexes up to 10,000 WAV, AIFF, MP3, OGG, M4A, AAC, or FLAC files.
It does not copy sample audio into the VST3 or WebView profile.

Sample banks are exposed as IDs such as `local_uzu_drumkit_main_bd`; use them
with Strudel's normal `s("...")` pattern syntax. The Drum Builder automatically
uses local `bd`, `sd`/`sn`, and `hh`/hat banks when present. Optional online
sample maps are not initialized at startup.

The editor includes a floating Drum Builder popover for a kick/snare/hi-hat
pattern. Left-click the toolbar button to open slider controls; right-click the
editor to choose a groove. Its cycle speed and level sliders generate named
numeric constants in the Strudel code. Insert/Update replaces the editor
contents; playback still starts only when Run is pressed.

Hydra's `hydra-synth` runtime is copied from the pinned npm dependency into the
VST3's web assets and loaded locally by Strudel. The build includes the
Strudel AGPL and Hydra license notices under `vendor/`.

Run `npm ci && npm run build` from this directory to build the page alone. The
Windows target at `../native/vst3` packages the page into the VST3 bundle.

The first editor keeps Strudel in WebView2 because its full REPL is a browser
application. egui is intentionally deferred; it can be added later for native
plugin controls without replacing Strudel's editor or language runtime.
