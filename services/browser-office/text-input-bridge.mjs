/* SPDX-License-Identifier: MPL-2.0 */

// The engine's Qt layer (5.15) reads only keydown and keyup on its canvas and
// passes a key's text to LibreOffice only when the key carries one character.
// The browser does not run an input method on a canvas, so Korean, Japanese
// and Chinese text (and Android keyboards for every language) never reached
// the document.
//
// Keyboard focus therefore sits in a hidden text field over the canvas, where
// the browser does run the input method. Ordinary key presses are handed to
// the canvas unchanged; the input method's own key presses are not. The
// unfinished syllable shows next to where the person last clicked, and each
// committed character is typed into LibreOffice as a one-character key
// press. The bridge never sends Backspace on the input method's behalf:
// outside text editing, Backspace deletes the selected shape.

const inputMethodKeyCode = 229;

export function createTextInputBridge({ typeKey, showComposition }) {
  let composing = false;
  // The last key handed to Qt. When the browser also reports that key's text
  // as input (a shortcut it was allowed to handle), it must not be typed
  // twice.
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
    // True when the key press belongs to the input method and must not be
    // handed to Qt.
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
      // pastes reached Qt as key presses.
    },
  };
}

// Connects the bridge to the engine canvas through the hidden text field.
export function installTextInputBridge({ canvas, textInput, compositionBox }) {
  let anchor = null;
  const handToCanvas = (type, init) =>
    canvas.dispatchEvent(
      new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }),
    );
  const typeKey = (init) => {
    handToCanvas("keydown", init);
    handToCanvas("keyup", init);
  };
  const keyInit = (event) => ({
    key: event.key,
    code: event.code,
    location: event.location,
    repeat: event.repeat,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
  });
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
  const focusTextInput = () => {
    if (document.activeElement !== textInput)
      textInput.focus({ preventScroll: true });
  };
  // Clearing during a composition would cancel it.
  const clearTextInput = () => {
    if (!bridge.composing && textInput.value) textInput.value = "";
  };
  canvas.addEventListener(
    "pointerdown",
    (event) => {
      anchor = { x: event.clientX, y: event.clientY };
      // The input method's candidate window opens at the text field.
      textInput.style.left = `${event.clientX}px`;
      textInput.style.top = `${event.clientY}px`;
    },
    true,
  );
  canvas.addEventListener("pointerup", focusTextInput);
  canvas.addEventListener("focus", focusTextInput);
  textInput.addEventListener("keydown", (event) => {
    if (bridge.keydown(event)) return;
    handToCanvas("keydown", keyInit(event));
    // Plain keys belong to the document; the browser keeps its shortcuts.
    if (!event.ctrlKey && !event.metaKey) event.preventDefault();
  });
  textInput.addEventListener("keyup", (event) => {
    if (!bridge.keyup(event)) handToCanvas("keyup", keyInit(event));
  });
  textInput.addEventListener("compositionstart", () =>
    bridge.compositionstart(),
  );
  textInput.addEventListener("compositionupdate", (event) =>
    bridge.compositionupdate(event),
  );
  textInput.addEventListener("compositionend", (event) => {
    bridge.compositionend(event);
    setTimeout(clearTextInput);
  });
  textInput.addEventListener("input", (event) => {
    bridge.input(event);
    if (!event.isComposing) setTimeout(clearTextInput);
  });
}
