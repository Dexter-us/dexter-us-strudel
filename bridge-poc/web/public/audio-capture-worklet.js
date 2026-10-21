const HEADER_BYTES = 64;
const HEADER_MAGIC_OFFSET = 0;
const HEADER_VERSION_OFFSET = 4;
const HEADER_CHANNELS_OFFSET = 8;
const HEADER_CAPACITY_OFFSET = 12;
const HEADER_WRITE_FRAME_OFFSET = 16;
const HEADER_SAMPLE_RATE_OFFSET = 20;
const EXPECTED_MAGIC = 0x53425247; // "SBRG"
const EXPECTED_VERSION = 1;
const NOTICE_FRAMES = 512;

class NativePcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.header = null;
    this.samples = null;
    this.channels = 2;
    this.capacityFrames = 0;
    this.writeFrame = 0;
    this.framesSinceNotice = 0;
    this.port.onmessage = (event) => this.initialize(event.data);
  }

  initialize(message) {
    if (message?.type !== "initialize" || !(message.buffer instanceof ArrayBuffer)) {
      this.port.postMessage({ type: "bridge-error", message: "Invalid shared buffer handoff" });
      return;
    }

    const buffer = message.buffer;
    const header = new DataView(buffer, 0, HEADER_BYTES);
    const magic = header.getUint32(HEADER_MAGIC_OFFSET, true);
    const version = header.getUint32(HEADER_VERSION_OFFSET, true);
    const channels = header.getUint32(HEADER_CHANNELS_OFFSET, true);
    const capacityFrames = header.getUint32(HEADER_CAPACITY_OFFSET, true);
    const hostSampleRate = header.getUint32(HEADER_SAMPLE_RATE_OFFSET, true);

    if (
      magic !== EXPECTED_MAGIC ||
      version !== EXPECTED_VERSION ||
      channels !== 2 ||
      hostSampleRate !== sampleRate ||
      capacityFrames < NOTICE_FRAMES * 2 ||
      buffer.byteLength < HEADER_BYTES + capacityFrames * channels * Float32Array.BYTES_PER_ELEMENT
    ) {
      this.port.postMessage({ type: "bridge-error", message: "Shared buffer header or size is invalid" });
      return;
    }

    this.header = header;
    this.samples = new Float32Array(buffer, HEADER_BYTES, capacityFrames * channels);
    this.channels = channels;
    this.capacityFrames = capacityFrames;
    this.writeFrame = header.getUint32(HEADER_WRITE_FRAME_OFFSET, true);
    this.port.postMessage({
      type: "bridge-ready",
      channels,
      capacityFrames,
      sampleRate: hostSampleRate,
    });
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (output) {
      for (const channel of output) channel.fill(0);
    }

    const input = inputs[0];
    if (!this.samples || !input || input.length === 0 || input[0].length === 0) {
      return true;
    }

    const left = input[0];
    const right = input[1] ?? left;
    const frameCount = left.length;

    for (let frame = 0; frame < frameCount; frame += 1) {
      const slot = (this.writeFrame % this.capacityFrames) * this.channels;
      this.samples[slot] = left[frame];
      this.samples[slot + 1] = right[frame];
      this.writeFrame = (this.writeFrame + 1) >>> 0;
    }

    this.framesSinceNotice += frameCount;
    if (this.framesSinceNotice >= NOTICE_FRAMES) {
      this.header.setUint32(HEADER_WRITE_FRAME_OFFSET, this.writeFrame, true);
      this.port.postMessage({
        type: "audio-ready",
        writeFrame: this.writeFrame,
      });
      this.framesSinceNotice %= NOTICE_FRAMES;
    }

    return true;
  }
}

registerProcessor("native-pcm-capture", NativePcmCaptureProcessor);
