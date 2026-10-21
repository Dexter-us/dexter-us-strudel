import {
  setAudioContext,
  setSuperdoughAudioController,
} from "@strudel/webaudio";
import { SuperdoughAudioController } from "superdough/superdoughoutput.mjs";
import { version as appVersion } from "../package.json";
import "./style.css";

const status = document.querySelector("#bridge-status");
const connectButton = document.querySelector("#connect-bridge");
const runButton = document.querySelector("#run-strudel");
const audioFormat = document.querySelector("#audio-format");
const audioFrames = document.querySelector("#audio-frames");
const editorMount = document.querySelector("#editor-mount");
const versionLabel = document.querySelector("#app-version");

let bridgeNode = null;
let lastWriteFrame = 0;
let strudelMounted = false;
let strudelEditor = null;
let strudelRunning = false;
let userChangedEditor = false;
const localCodeKey = "dexter-us-strudel-editor-code-v1";

function readLocalEditorCode() {
  try {
    return window.localStorage.getItem(localCodeKey);
  } catch {
    return null;
  }
}

function writeLocalEditorCode(code) {
  try {
    window.localStorage.setItem(localCodeKey, code);
  } catch {
    // VST3 component state remains available if browser storage is disabled.
  }
}

let initialEditorCode = readLocalEditorCode();
let runtimeLoadError = null;
const strudelRuntimeReady = import("@strudel/repl").catch((error) => {
  runtimeLoadError = error;
  return null;
});

versionLabel.textContent = `v${appVersion}`;

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
  editorMount.inert = false;
  editorMount.replaceChildren();
  const loading = document.createElement("div");
  loading.className = "loading-state";
  loading.textContent = "Loading Strudel editor…";
  editorMount.append(loading);

  try {
    await strudelRuntimeReady;
    if (runtimeLoadError) {
      throw runtimeLoadError;
    }
    if (!customElements.get("strudel-editor")) {
      throw new Error("Strudel's editor component was not registered");
    }

    const editor = document.createElement("strudel-editor");
    editor.setAttribute("code", initialEditorCode ?? starterCode);
    editorMount.replaceChildren(editor);
    strudelEditor = editor;

    // Strudel creates CodeMirror in a sibling from connectedCallback.
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    if (!editor.editor || !editorMount.querySelector(".cm-editor")) {
      throw new Error(
        "Strudel loaded, but CodeMirror did not mount. Reopen the editor and check the WebView2 Runtime.",
      );
    }

    strudelMounted = true;
    const contentDOM = editor.editor.editor?.contentDOM;
    if (!contentDOM) {
      throw new Error("Strudel's CodeMirror input surface was not available");
    }
    contentDOM.addEventListener("input", persistEditorCode);
    runButton.disabled = false;
    showStatus("Editor ready — press Run to start the pattern");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failure = document.createElement("pre");
    failure.className = "editor-error";
    failure.textContent = `Strudel editor failed to start:\n${message}`;
    editorMount.replaceChildren(failure);
    runButton.disabled = true;
    showStatus("Strudel editor failed to start", true);
    console.error("Strudel editor startup failed", error);
  }
}

function persistEditorCode() {
  const code = strudelEditor?.editor?.code;
  if (typeof code !== "string") return;
  userChangedEditor = true;
  initialEditorCode = code;
  writeLocalEditorCode(code);
  getWebViewBridge()?.postMessage(`editor-code:${code}`);
}

runButton.addEventListener("click", async () => {
  const mirror = strudelEditor?.editor;
  if (!mirror || !strudelMounted) {
    showStatus("Strudel editor is not ready", true);
    return;
  }

  runButton.disabled = true;
  try {
    if (strudelRunning) {
      await mirror.stop();
      strudelRunning = false;
      runButton.textContent = "Run";
      showStatus("Pattern stopped");
    } else {
      await mirror.evaluate();
      strudelRunning = true;
      runButton.textContent = "Stop";
      showStatus("Pattern running");
    }
  } catch (error) {
    strudelRunning = false;
    runButton.textContent = "Run";
    showStatus(
      error instanceof Error ? `Strudel: ${error.message}` : String(error),
      true,
    );
  } finally {
    runButton.disabled = false;
  }
});

async function installAudioCapture(buffer, config = {}) {
  const sampleRate = Number(config.sampleRate ?? 48000);
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
    throw new Error("Native host supplied an unsupported sample rate");
  }

  let audioContext;
  try {
    audioContext = new AudioContext({
      sampleRate,
      latencyHint: "interactive",
      sinkId: { type: "none" },
    });
  } catch {
    throw new Error(
      "This WebView2 Runtime must support AudioContext's silent sink to keep browser audio out of the plugin path",
    );
  }
  if (audioContext.sinkId?.type !== "none") {
    await audioContext.close();
    throw new Error(
      "This WebView2 Runtime did not select the silent audio sink",
    );
  }
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
      connectButton.textContent = "Audio bridge connected";
      connectButton.disabled = true;
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
  webview.addEventListener("message", (event) => {
    if (
      typeof event.data === "string" &&
      event.data.startsWith("editor-code-state:")
    ) {
      const componentCode = event.data.slice("editor-code-state:".length);
      const restoredCode =
        componentCode.length > 0 ? componentCode : readLocalEditorCode();
      if (!userChangedEditor && restoredCode !== null) {
        initialEditorCode = restoredCode;
        writeLocalEditorCode(restoredCode);
        if (
          strudelMounted &&
          strudelEditor?.editor?.code !== restoredCode
        ) {
          strudelEditor.setAttribute("code", restoredCode);
        }
      }
      return;
    }
  });
  webview.addEventListener("sharedbufferreceived", async (event) => {
    try {
      await installAudioCapture(event.getBuffer(), event.additionalData ?? {});
    } catch (error) {
      showStatus(error instanceof Error ? error.message : String(error), true);
      connectButton.disabled = false;
    }
  });
  showStatus("WebView2 host detected — requesting shared audio buffer");
  webview.postMessage("request-editor-code");
  webview.postMessage({ type: "request-audio-buffer" });
} else {
  showStatus("Browser preview only — native audio bridge unavailable");
}

