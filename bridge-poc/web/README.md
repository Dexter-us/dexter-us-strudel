# Dexter U.S. Strudel VST3

This page uses Strudel's published `@strudel/repl` and `@strudel/webaudio`
packages. It leaves Strudel's pattern language, synths, samples, buses, and
effects intact, and redirects only the final Superdough output into an
`AudioWorkletNode`.

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

The standard Strudel sample maps are loaded from their upstream repositories at
startup; individual audio samples are fetched on demand. Persistent sample
caching is not implemented yet.

Run `npm ci && npm run build` from this directory to build the page alone. The
Windows target at `../native/vst3` packages the page into the VST3 bundle.

The first editor keeps Strudel in WebView2 because its full REPL is a browser
application. egui is intentionally deferred; it can be added later for native
plugin controls without replacing Strudel's editor or language runtime.
