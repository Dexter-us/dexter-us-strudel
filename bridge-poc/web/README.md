# WebView2 Strudel audio-capture POC

This page uses Strudel's published `@strudel/repl` and `@strudel/webaudio`
packages. It leaves Strudel's pattern language, synths, samples, buses, and
effects intact, and redirects only the final Superdough output into an
`AudioWorkletNode`.

The native WebView2 host is expected to:

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
The VST3 callback must output silence on underrun and must never call WebView2,
wait for the renderer, allocate, or take a UI-thread lock.

This is only the web-side handoff. The Windows host and VST3 processor still
need implementation and Windows/DAW validation. Run `npm install` and `npm run
build` from this directory to build the page.
