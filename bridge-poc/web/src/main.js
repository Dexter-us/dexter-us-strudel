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
const drumBuilderToggle = document.querySelector("#drum-builder-toggle");
const drumBuilderPanel = document.querySelector("#drum-builder-panel");
const drumCodePreview = document.querySelector("#drum-code-preview");
const insertDrumPatternButton = document.querySelector("#insert-drum-pattern");
const drumGrooveMenu = document.querySelector("#drum-groove-menu");
const audioFormat = document.querySelector("#audio-format");
const audioFrames = document.querySelector("#audio-frames");
const editorMount = document.querySelector("#editor-mount");
const versionLabel = document.querySelector("#app-version");
const drumControls = [
  ["cycleSpeed", document.querySelector("#cycle-speed"), document.querySelector("#cycle-speed-value")],
  ["kickLevel", document.querySelector("#kick-level"), document.querySelector("#kick-level-value")],
  ["snareLevel", document.querySelector("#snare-level"), document.querySelector("#snare-level-value")],
  ["hatLevel", document.querySelector("#hat-level"), document.querySelector("#hat-level-value")],
];
const drumGrooves = {
  fourOnFloor: {
    label: "Four-on-the-floor",
    kick: "bd*4",
    snare: "~ sd ~ sd",
    hats: "hh*8",
  },
  rock: {
    label: "Rock groove",
    kick: "bd ~ ~ bd",
    snare: "~ sd ~ sd",
    hats: "hh*8",
  },
  breakbeat: {
    label: "Breakbeat",
    kick: "bd ~ ~ bd ~ ~ bd ~",
    snare: "~ ~ sd ~ ~ sd ~ ~",
    hats: "hh*8",
  },
};
let selectedDrumGroove = "fourOnFloor";

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
  saveEditorCode(code);
}

function saveEditorCode(code) {
  userChangedEditor = true;
  initialEditorCode = code;
  writeLocalEditorCode(code);
  getWebViewBridge()?.postMessage(`editor-code:${code}`);
}

function generateDrumCode() {
  const groove = drumGrooves[selectedDrumGroove];
  const values = Object.fromEntries(
    drumControls.map(([name, input]) => [
      name,
      Number(input.value).toFixed(2),
    ]),
  );
  return `// ${groove.label}
const cycleSpeed = ${values.cycleSpeed}
const kickLevel = ${values.kickLevel}
const snareLevel = ${values.snareLevel}
const hatLevel = ${values.hatLevel}

setcps(cycleSpeed)

stack(
  s("${groove.kick}").gain(kickLevel),
  s("${groove.snare}").gain(snareLevel),
  s("${groove.hats}").gain(hatLevel)
)`;
}

function updateDrumBuilder() {
  for (const [, input, output] of drumControls) {
    output.value = Number(input.value).toFixed(2);
  }
  drumCodePreview.textContent = generateDrumCode();
}

drumBuilderToggle.addEventListener("click", () => {
  const isOpen = drumBuilderPanel.hidden;
  drumBuilderPanel.hidden = !isOpen;
  drumBuilderToggle.setAttribute("aria-expanded", String(isOpen));
});

function openDrumGrooveMenu(event) {
  event.preventDefault();
  drumGrooveMenu.hidden = false;
  const menuWidth = 220;
  const menuHeight = 150;
  drumGrooveMenu.style.left = `${Math.max(
    8,
    Math.min(event.clientX, window.innerWidth - menuWidth - 8),
  )}px`;
  drumGrooveMenu.style.top = `${Math.max(
    8,
    Math.min(event.clientY, window.innerHeight - menuHeight - 8),
  )}px`;
  drumGrooveMenu.querySelector("button")?.focus();
}

drumBuilderToggle.addEventListener("contextmenu", openDrumGrooveMenu);
editorMount.addEventListener("contextmenu", openDrumGrooveMenu, true);

drumGrooveMenu.addEventListener("click", (event) => {
  const choice = event.target.closest("[data-groove]");
  if (!choice) return;
  selectedDrumGroove = choice.dataset.groove;
  updateDrumBuilder();
  drumBuilderPanel.hidden = false;
  drumBuilderToggle.setAttribute("aria-expanded", "true");
  drumGrooveMenu.hidden = true;
  drumBuilderToggle.focus();
});

document.addEventListener("pointerdown", (event) => {
  if (
    !drumBuilderPanel.hidden &&
    !drumBuilderPanel.contains(event.target) &&
    event.target !== drumBuilderToggle
  ) {
    drumBuilderPanel.hidden = true;
    drumBuilderToggle.setAttribute("aria-expanded", "false");
  }
  if (
    !drumGrooveMenu.hidden &&
    !drumGrooveMenu.contains(event.target) &&
    !drumBuilderToggle.contains(event.target)
  ) {
    drumGrooveMenu.hidden = true;
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (!drumBuilderPanel.hidden) {
      drumBuilderPanel.hidden = true;
      drumBuilderToggle.setAttribute("aria-expanded", "false");
      drumBuilderToggle.focus();
    }
    if (!drumGrooveMenu.hidden) {
      drumGrooveMenu.hidden = true;
      drumBuilderToggle.focus();
    }
  }
});

for (const [, input] of drumControls) {
  input.addEventListener("input", updateDrumBuilder);
}

insertDrumPatternButton.addEventListener("click", () => {
  if (!strudelEditor || !strudelMounted) {
    showStatus("Connect the audio bridge before inserting a pattern", true);
    return;
  }
  const code = generateDrumCode();
  strudelEditor.setAttribute("code", code);
  saveEditorCode(code);
  showStatus("Drum code inserted — press Run to play it");
});

updateDrumBuilder();

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

