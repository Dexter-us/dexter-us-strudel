import {
  setAudioContext,
  setSuperdoughAudioController,
} from "@strudel/webaudio";
import { SuperdoughAudioController } from "superdough/superdoughoutput.mjs";
import "./style.css";

const status = document.querySelector("#bridge-status");
const connectButton = document.querySelector("#connect-bridge");
const audioFormat = document.querySelector("#audio-format");
const audioFrames = document.querySelector("#audio-frames");
const editorMount = document.querySelector("#editor-mount");

let bridgeNode = null;
let lastWriteFrame = 0;
let strudelMounted = false;

const starterCode = `setcps(0.75)
note("c3 eb3 g3 bb3").s("triangle")
  .slow(2)
  .room(0.25)`;

function showStatus(message, isError = false) {
  status.textContent = message;
  status.style.color = isError ? "#ff9b8f" : "#b7bbab";
}

function getWebViewBridge() {
  return window.chrome?.webview ?? null;
}

async function mountStrudel() {
  if (strudelMounted) return;
  await import("@strudel/repl");
  const editor = document.createElement("strudel-editor");
  editor.setAttribute("code", starterCode);
  editorMount.replaceChildren(editor);
  strudelMounted = true;
}

async function installAudioCapture(buffer, config = {}) {
  const sampleRate = Number(config.sampleRate ?? 48000);
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
    throw new Error("Native host supplied an unsupported sample rate");
  }

  const audioContext = new AudioContext({
    sampleRate,
    latencyHint: "interactive",
  });
  setAudioContext(audioContext);

  await audioContext.audioWorklet.addModule(
    `${import.meta.env.BASE_URL}audio-capture-worklet.js`,
  );

  bridgeNode = new AudioWorkletNode(audioContext, "native-pcm-capture", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: "explicit",
  });

  const controller = new SuperdoughAudioController(audioContext);
  const output = controller.output;
  output.destinationGain.disconnect();
  output.destinationGain.connect(bridgeNode);

  // Keep Strudel's complete Superdough graph (including synths, samples,
  // buses, and effects); only replace its final Web Audio destination.
  const originalReset = output.reset.bind(output);
  output.reset = () => {
    originalReset();
    output.destinationGain.disconnect();
    output.destinationGain.connect(bridgeNode);
  };
  setSuperdoughAudioController(controller);

  // The worklet emits silence to the browser device. Its captured input is
  // consumed by the native VST3 processor instead.
  bridgeNode.connect(audioContext.destination);
  bridgeNode.port.onmessage = async ({ data }) => {
    if (data?.type === "bridge-ready") {
      audioFormat.textContent =
        `${data.channels} channels · ${data.sampleRate} Hz · ${data.capacityFrames} frame ring`;
      await mountStrudel();
      editorMount.inert = false;
      showStatus("Shared audio buffer connected — use Strudel's play controls");
      return;
    }
    if (data?.type === "audio-ready") {
      lastWriteFrame = data.writeFrame >>> 0;
      audioFrames.textContent = `${lastWriteFrame.toLocaleString()} frames published`;
      getWebViewBridge()?.postMessage({
        type: "audio-ready",
        writeFrame: lastWriteFrame,
      });
      return;
    }
    if (data?.type === "bridge-error") {
      showStatus(data.message ?? "Audio bridge setup failed", true);
    }
  };

  bridgeNode.port.postMessage(
    { type: "initialize", buffer },
    [buffer],
  );
}

connectButton.addEventListener("click", () => {
  const webview = getWebViewBridge();
  if (!webview) {
    showStatus("Open this page inside the native WebView2 test host", true);
    return;
  }
  connectButton.disabled = true;
  showStatus("Requesting shared audio buffer…");
  webview.postMessage({ type: "request-audio-buffer" });
});

const webview = getWebViewBridge();
if (webview) {
  webview.addEventListener("sharedbufferreceived", async (event) => {
    try {
      await installAudioCapture(event.getBuffer(), event.additionalData ?? {});
    } catch (error) {
      showStatus(error instanceof Error ? error.message : String(error), true);
      connectButton.disabled = false;
    }
  });
  showStatus("WebView2 host detected — connect the audio bridge");
  webview.postMessage({ type: "request-audio-buffer" });
} else {
  showStatus("Browser preview only — native audio bridge unavailable");
}

// Keep getAudioContext referenced for diagnostics while the native host is
// being implemented; Strudel's REPL uses this same shared AudioContext.
window.strudelBridge = {
  getAudioContext,
};
