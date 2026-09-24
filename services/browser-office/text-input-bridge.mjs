/* SPDX-License-Identifier: MPL-2.0 */

// The engine's Qt layer (5.15) reads only keydown and keyup on its canvas and
// passes a key's text to LibreOffice only when the key carries one character.
// Text an input method composes (Korean, Japanese, Chinese, and Android
// keyboards for every language) arrives in composition and input events
// instead, so without this bridge it never reaches the document.
//
// The bridge keeps the input method's own key presses away from Qt, shows the
// unfinished syllable next to where the person last clicked, and types each
// committed character into LibreOffice as a one-character key press. It never
// sends Backspace on the input method's behalf: outside text editing,
// Backspace deletes the selected shape.

const inputMethodKeyCode = 229;

export function createTextInputBridge({ typeKey, showComposition }) {
  let composing = false;
  // The last key that went straight to Qt. The browser reports that key's
  // text again in an input event, which must not type it twice.
  let directKey = null;

  const typeText = (text) => {
    for (const character of text) {
      // Qt drops key text longer than one UTF-16 unit, so characters outside
      // the Basic Multilingual Plane (emoji) cannot be typed this way.
      if (character.length !== 1) continue;
      if (character === "\n" || character === "\r")
        typeKey({ key: "Enter", code: "Enter" });
      else if (character === "\t") typeKey({ key: "Tab", code: "Tab" });
      else typeKey({ key: character, code: "" });
    }
  };

  const belongsToInputMethod = (event) =>
    event.isComposing || event.keyCode === inputMethodKeyCode;

  return {
    get composing() {
      return composing;
    },
    // True when the key press belongs to the input method and must not
    // reach Qt.
    keydown(event) {
      if (belongsToInputMethod(event)) return true;
      directKey = event.key;
      return false;
    },
    keyup(event) {
      return belongsToInputMethod(event);
    },
    compositionstart() {
      composing = true;
      showComposition("");
    },
    compositionupdate(event) {
      showComposition(event.data ?? "");
    },
    compositionend(event) {
      composing = false;
      showComposition("");
      typeText(event.data ?? "");
    },
    input(event) {
      if (composing || event.isComposing) return;
      if (
        event.inputType === "insertText" ||
        event.inputType === "insertReplacementText"
      ) {
        const text = event.data ?? "";
        if (text && text === directKey) {
          directKey = null;
          return;
        }
        typeText(text);
        return;
      }
      if (
        event.inputType === "insertParagraph" ||
        event.inputType === "insertLineBreak"
      ) {
        if (directKey === "Enter") {
          directKey = null;
          return;
        }
        typeKey({
          key: "Enter",
          code: "Enter",
          shiftKey: event.inputType === "insertLineBreak",
        });
      }
      // Composition text arrives through compositionend; deletions and
      // pastes already reached Qt as key presses.
    },
  };
}

// Connects the bridge to the engine canvas. The canvas is contenteditable, so
// the browser runs the input method on it and also keeps the typed text as
// hidden children, which are cleared after each input.
export function installTextInputBridge({ canvas, compositionBox }) {
  const synthetic = new WeakSet();
  let anchor = null;
  const typeKey = (init) => {
    for (const type of ["keydown", "keyup"]) {
      const event = new KeyboardEvent(type, {
        bubbles: true,
        cancelable: true,
        ...init,
      });
      synthetic.add(event);
      canvas.dispatchEvent(event);
    }
  };
  const showComposition = (text) => {
    compositionBox.textContent = text;
    compositionBox.hidden = !text;
    if (!text) return;
    const bounds = canvas.getBoundingClientRect();
    const x = anchor?.x ?? bounds.left + bounds.width / 2;
    const y = anchor?.y ?? bounds.top + bounds.height / 2;
    const width = compositionBox.offsetWidth;
    const height = compositionBox.offsetHeight;
    compositionBox.style.left = `${Math.max(bounds.left, Math.min(x, bounds.right - width))}px`;
    compositionBox.style.top = `${Math.max(bounds.top, Math.min(y + 12, bounds.bottom - height))}px`;
  };
  const bridge = createTextInputBridge({ typeKey, showComposition });
  // Clearing during a composition would cancel it.
  const clearHiddenText = () => {
    if (!bridge.composing && canvas.firstChild) canvas.replaceChildren();
  };
  for (const type of ["keydown", "keyup"])
    window.addEventListener(
      type,
      (event) => {
        if (event.target !== canvas || synthetic.has(event)) return;
        if (bridge[type](event)) event.stopImmediatePropagation();
      },
      true,
    );
  canvas.addEventListener(
    "pointerdown",
    (event) => {
      anchor = { x: event.clientX, y: event.clientY };
    },
    true,
  );
  canvas.addEventListener("compositionstart", () => bridge.compositionstart());
  canvas.addEventListener("compositionupdate", (event) =>
    bridge.compositionupdate(event),
  );
  canvas.addEventListener("compositionend", (event) => {
    bridge.compositionend(event);
    setTimeout(clearHiddenText);
  });
  canvas.addEventListener("input", (event) => {
    bridge.input(event);
    if (!event.isComposing) setTimeout(clearHiddenText);
  });
}
