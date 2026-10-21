/*
 * Based on @strudel/repl 1.3.0 repl-component.mjs.
 * Copyright (C) 2022 Strudel contributors.
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * The custom component uses offline-prebake.js so startup does not fetch
 * sample maps from the internet.
 */
import { silence } from "@strudel/core";
import { getDrawContext } from "@strudel/draw";
import { transpiler } from "@strudel/transpiler";
import {
  getAudioContext,
  webaudioOutput,
  initAudioOnFirstClick,
} from "@strudel/webaudio";
import { StrudelMirror, codemirrorSettings } from "@strudel/codemirror";
import { prebake } from "./offline-prebake.js";

if (typeof HTMLElement !== "undefined") {
  initAudioOnFirstClick();

  class StrudelRepl extends HTMLElement {
    static observedAttributes = ["code"];
    settings = codemirrorSettings.get();
    editor = null;
    sync = false;
    solo = true;

    attributeChangedCallback(name, oldValue, newValue) {
      if (name === "code") {
        this.code = newValue;
        this.editor?.setCode(newValue);
      }
    }

    connectedCallback() {
      setTimeout(() => {
        const code = (this.innerHTML + "")
          .replace("<!--", "")
          .replace("-->", "")
          .trim();
        if (code) this.setAttribute("code", code);
      });

      const container = document.createElement("div");
      this.parentElement.insertBefore(container, this.nextSibling);
      this.editor = new StrudelMirror({
        defaultOutput: webaudioOutput,
        getTime: () => getAudioContext().currentTime,
        transpiler,
        root: container,
        initialCode: "// LOADING",
        pattern: silence,
        drawTime: [-2, 2],
        drawContext: getDrawContext(),
        prebake,
        onUpdateState: (state) => {
          this.dispatchEvent(
            new CustomEvent("update", {
              detail: state,
            }),
          );
        },
        solo: this.solo,
        sync: this.sync,
      });
      this.editor.updateSettings(this.settings);
      this.editor.setCode(this.code);
    }
  }

  customElements.define("strudel-editor", StrudelRepl);
}
