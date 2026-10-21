import {
  samples,
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
const settingsToggle = document.querySelector("#settings-toggle");
const settingsPanel = document.querySelector("#settings-panel");
const settingsClose = document.querySelector("#settings-close");
const themeSelect = document.querySelector("#setting-theme");
const fontSizeInput = document.querySelector("#setting-font-size");
const fontSizeOutput = document.querySelector("#setting-font-size-value");
const opacityInput = document.querySelector("#setting-opacity");
const opacityOutput = document.querySelector("#setting-opacity-value");
const opacityStatus = document.querySelector("#opacity-status");
const prebakeSource = document.querySelector("#prebake-source");
const prebakeImportFile = document.querySelector("#prebake-import-file");
const prebakeStatus = document.querySelector("#prebake-status");
const prebakeStorageKey = "dexter-us-strudel-prebake-v1";
const opacityStorageKey = "dexter-us-strudel-window-opacity-v1";
const defaultEditorSettings = {
  keybindings: "codemirror",
  isBracketMatchingEnabled: false,
  isBracketClosingEnabled: true,
  isLineNumbersDisplayed: true,
  isActiveLineHighlighted: false,
  isAutoCompletionEnabled: false,
  isPatternHighlightingEnabled: true,
  isFlashEnabled: true,
  isTooltipEnabled: false,
  isLineWrappingEnabled: false,
  isTabIndentationEnabled: false,
  isMultiCursorEnabled: false,
  theme: "strudelTheme",
  fontFamily: "monospace",
  fontSize: 18,
};
const editorSettingInputs = [
  ...document.querySelectorAll("[data-editor-setting]"),
];
const sampleFolderButton = document.querySelector("#sample-folder-button");
const sampleFolderStatus = document.querySelector("#sample-folder-status");
const sampleBankList = document.querySelector("#sample-bank-list");
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
let localSampleBankIds = [];
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
const strudelRuntimeReady = import("./strudel-repl.js").catch((error) => {
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

function readSavedOpacity() {
  try {
    const value = Number(window.localStorage.getItem(opacityStorageKey));
    return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 100;
  } catch {
    return 100;
  }
}

function applyWindowOpacity(value, notifyNative = true) {
  const opacity = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  const normalized = opacity / 100;
  document.documentElement.style.setProperty("--window-opacity", normalized);
  opacityInput.value = String(opacity);
  opacityOutput.value = `${opacity}%`;
  try {
    window.localStorage.setItem(opacityStorageKey, String(opacity));
  } catch {
    // Keep the current appearance for this editor session.
  }
  if (notifyNative) {
    getWebViewBridge()?.postMessage(`window-opacity:${opacity}`);
  }
}

function getEditorSettings() {
  if (strudelEditor?.settings) return strudelEditor.settings;
  try {
    const saved = JSON.parse(
      window.localStorage.getItem("codemirror-settings") ?? "{}",
    );
    return { ...defaultEditorSettings, ...saved };
  } catch {
    return { ...defaultEditorSettings };
  }
}

function updateEditorSettings(update) {
  const nextSettings = { ...getEditorSettings(), ...update };
  if (strudelEditor?.editor) {
    strudelEditor.settings = nextSettings;
    strudelEditor.editor.updateSettings(nextSettings);
    return;
  }
  try {
    window.localStorage.setItem(
      "codemirror-settings",
      JSON.stringify(nextSettings),
    );
  } catch {
    // The options can still be applied after the editor mounts this session.
  }
}

function populateEditorSettings() {
  const settings = getEditorSettings();
  themeSelect.value = settings.theme ?? "strudelTheme";
  fontSizeInput.value = String(settings.fontSize ?? 18);
  fontSizeOutput.value = fontSizeInput.value;
  for (const input of editorSettingInputs) {
    input.checked = Boolean(settings[input.dataset.editorSetting]);
  }
}

async function readBundledPrebake() {
  const response = await fetch(
    new URL("/prebake.strudel", window.location.href),
    { cache: "no-store" },
  );
  if (!response.ok) {
    throw new Error(`Bundled Prebake file returned ${response.status}`);
  }
  return response.text();
}

function refreshPrebakeEditor() {
  if (typeof window.__dexterStrudelPrebakeSource === "string") {
    prebakeSource.value = window.__dexterStrudelPrebakeSource;
  }
  if (window.__dexterStrudelPrebakeError) {
    prebakeStatus.textContent =
      `Prebake has an error: ${window.__dexterStrudelPrebakeError}`;
  } else {
    prebakeStatus.textContent =
      "Loaded at startup. Edits are saved in this WebView profile; export a copy to keep them portable.";
  }
}

function exportPrebake() {
  const file = new Blob([prebakeSource.value], { type: "text/plain" });
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = "prebake.strudel";
  link.click();
  URL.revokeObjectURL(url);
  prebakeStatus.textContent =
    "Exported prebake.strudel. Replace the bundled file to carry it with the VST3.";
}

applyWindowOpacity(readSavedOpacity(), false);

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
    await editor.editor.prebaked;
    populateEditorSettings();
    refreshPrebakeEditor();

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
  const localDrums = {
    bd: findLocalDrumBank(["bd", "kick", "kickdrum", "bassdrum"], "bd"),
    sd: findLocalDrumBank(["sd", "sn", "snare", "snaredrum"], "sd"),
    hh: findLocalDrumBank(
      ["hh", "ch", "closedhat", "hihat", "hat", "oh", "openhat"],
      "hh",
    ),
  };
  const useLocalBank = (pattern) =>
    pattern.replace(/\b(bd|sd|hh)\b/g, (sample) => localDrums[sample]);
  const kickPattern = useLocalBank(groove.kick);
  const snarePattern = useLocalBank(groove.snare);
  const hatPattern = useLocalBank(groove.hats);
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
  s("${kickPattern}").gain(kickLevel),
  s("${snarePattern}").gain(snareLevel),
  s("${hatPattern}").gain(hatLevel)
)`;
}

function findLocalDrumBank(aliases, fallback) {
  return (
    localSampleBankIds.find((bank) =>
      aliases.some((alias) => bank.endsWith(`_${alias}`)),
    ) ?? fallback
  );
}

function updateDrumBuilder() {
  for (const [, input, output] of drumControls) {
    output.value = Number(input.value).toFixed(2);
  }
  drumCodePreview.textContent = generateDrumCode();
}

function sampleSlug(value) {
  return (
    value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "samples"
  );
}

async function registerLocalSampleFolder(data) {
  if (!data.selected) {
    localSampleBankIds = [];
    sampleFolderStatus.textContent =
      "No sample folder found beside the VST3 bundle.";
    sampleBankList.replaceChildren();
    updateDrumBuilder();
    return;
  }

  const filePaths = Array.isArray(data.files) ? data.files : [];
  const packSlug = sampleSlug(data.folder || "samples");
  const sampleMap = Object.create(null);

  for (const filePath of filePaths) {
    if (typeof filePath !== "string") continue;
    const parts = filePath
      .split(/[\\/]/)
      .filter((part) => part && part !== "." && part !== "..");
    if (!parts.length) continue;

    const filename = parts.at(-1);
    const stem = filename.replace(/\.[^.]+$/, "");
    const parent = parts.length > 1 ? parts.slice(0, -1).join("_") : stem;
    const bank = `local_${packSlug}_${sampleSlug(parent)}`;
    const encodedPath = parts.map(encodeURIComponent).join("/");
    (sampleMap[bank] ??= []).push(
      `https://strudel-samples.local/${encodedPath}`,
    );
  }

  for (const [sample, aliases] of Object.entries({
    bd: ["bd", "kick", "kickdrum", "bassdrum"],
    sd: ["sd", "sn", "snare", "snaredrum"],
    hh: ["hh", "ch", "closedhat", "hihat", "hat", "oh", "openhat"],
  })) {
    const localBank = Object.keys(sampleMap).find((bank) =>
      aliases.some((alias) => bank.endsWith(`_${alias}`)),
    );
    if (localBank) sampleMap[sample] = sampleMap[localBank];
  }

  const bankIds = Object.keys(sampleMap).sort();
  if (!bankIds.length) {
    localSampleBankIds = [];
    sampleFolderStatus.textContent =
      `Found “${data.folder}”, but no supported audio files.`;
    sampleBankList.replaceChildren();
    updateDrumBuilder();
    return;
  }

  try {
    await samples(sampleMap);
  } catch (error) {
    sampleFolderStatus.textContent =
      error instanceof Error
        ? `Could not register local samples: ${error.message}`
        : "Could not register local samples.";
    return;
  }

  localSampleBankIds = bankIds;
  let portability = "inside the VST3 folder; it will travel with the plugin";
  if (!data.portable) {
    portability =
      "outside the VST3 folder; move it beside Contents to make it portable";
  } else if (!data.remembered) {
    portability =
      "portable folder selected; it could not save its relative path, so use Samples or uzu-drumkit-main for automatic discovery";
  }
  sampleFolderStatus.textContent =
    `${filePaths.length}${data.truncated ? "+" : ""} audio files · ${bankIds.length} sample banks · ${portability}`;

  sampleBankList.replaceChildren();
  for (const bank of bankIds) {
    const item = document.createElement("li");
    const code = document.createElement("code");
    code.textContent = bank;
    item.append(code);
    sampleBankList.append(item);
  }
  updateDrumBuilder();
}

drumBuilderToggle.addEventListener("click", () => {
  const isOpen = drumBuilderPanel.hidden;
  drumBuilderPanel.hidden = !isOpen;
  drumBuilderToggle.setAttribute("aria-expanded", String(isOpen));
});

settingsToggle.addEventListener("click", () => {
  const isOpen = settingsPanel.hidden;
  settingsPanel.hidden = !isOpen;
  settingsToggle.setAttribute("aria-expanded", String(isOpen));
  if (isOpen) {
    populateEditorSettings();
    refreshPrebakeEditor();
  }
});

settingsClose.addEventListener("click", () => {
  settingsPanel.hidden = true;
  settingsToggle.setAttribute("aria-expanded", "false");
  settingsToggle.focus();
});

themeSelect.addEventListener("change", () => {
  updateEditorSettings({ theme: themeSelect.value });
});

fontSizeInput.addEventListener("input", () => {
  fontSizeOutput.value = fontSizeInput.value;
  updateEditorSettings({ fontSize: Number(fontSizeInput.value) });
});

for (const input of editorSettingInputs) {
  input.addEventListener("change", () => {
    updateEditorSettings({
      [input.dataset.editorSetting]: input.checked,
    });
  });
}

opacityInput.addEventListener("input", () => {
  applyWindowOpacity(opacityInput.value);
});

document.querySelector("#prebake-import").addEventListener("click", () => {
  prebakeImportFile.click();
});

prebakeImportFile.addEventListener("change", async () => {
  const file = prebakeImportFile.files?.[0];
  if (!file) return;
  try {
    prebakeSource.value = await file.text();
    prebakeStatus.textContent =
      `Imported ${file.name}. Save it for the next editor open, or export a portable copy.`;
  } catch (error) {
    prebakeStatus.textContent =
      error instanceof Error ? error.message : "Could not read that file.";
  }
  prebakeImportFile.value = "";
});

document.querySelector("#prebake-export").addEventListener("click", exportPrebake);

document.querySelector("#prebake-save").addEventListener("click", () => {
  try {
    window.localStorage.setItem(prebakeStorageKey, prebakeSource.value);
    prebakeStatus.textContent =
      "Saved in this WebView profile. Close and reopen the editor to load it; export the file to keep it portable.";
  } catch {
    prebakeStatus.textContent =
      "Could not save to WebView storage. Export prebake.strudel instead.";
  }
});

document.querySelector("#prebake-reset").addEventListener("click", async () => {
  try {
    window.localStorage.removeItem(prebakeStorageKey);
    prebakeSource.value = await readBundledPrebake();
    prebakeStatus.textContent =
      "Using the bundled portable file on the next editor open.";
  } catch (error) {
    prebakeStatus.textContent =
      error instanceof Error ? error.message : "Could not read the bundled file.";
  }
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
  if (
    !settingsPanel.hidden &&
    !settingsPanel.contains(event.target) &&
    event.target !== settingsToggle
  ) {
    settingsPanel.hidden = true;
    settingsToggle.setAttribute("aria-expanded", "false");
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (!settingsPanel.hidden) {
      settingsPanel.hidden = true;
      settingsToggle.setAttribute("aria-expanded", "false");
      settingsToggle.focus();
    }
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

sampleFolderButton.addEventListener("click", () => {
  const webview = getWebViewBridge();
  if (!webview) {
    sampleFolderStatus.textContent =
      "Choose a sample folder from the VST3 editor.";
    return;
  }
  webview.postMessage("choose-sample-folder");
});

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
    if (event.data?.type === "window-opacity-status") {
      opacityStatus.textContent = event.data.webViewAccepted
        ? "WebView2 accepted the alpha setting; VSTHost may still composite the plugin as opaque."
        : "WebView2 did not accept native alpha. Editor background opacity remains adjustable.";
      return;
    }
    if (event.data?.type === "sample-folder-index") {
      void registerLocalSampleFolder(event.data);
      return;
    }
    if (event.data?.type === "sample-folder-error") {
      sampleFolderStatus.textContent =
        event.data.message ?? "Could not open the sample folder.";
      return;
    }
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
  webview.postMessage(`window-opacity:${readSavedOpacity()}`);
  webview.postMessage("request-editor-code");
  webview.postMessage("request-sample-folder-index");
  webview.postMessage({ type: "request-audio-buffer" });
} else {
  showStatus("Browser preview only — native audio bridge unavailable");
}

