(() => {
  "use strict";

  function applyTypography() {
    if (document.getElementById("spellbook-injected-toolbar-style")) return;
    const style = document.createElement("style");
    style.id = "spellbook-injected-toolbar-style";
    style.textContent = `
      html, body, .notebookbar, .notebookbar *, .ui-content, #Home-container, #navigation-sidebar, .navigation-header, .main-nav {
        font-family: -apple-system, BlinkMacSystemFont, "Pretendard Variable", Pretendard, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif !important;
      }
      .notebookbar, .notebookbar .ui-content {
        font-size: 11px !important;
      }
      .notebookbar button, .notebookbar .ui-text, .notebookbar span, .notebookbar label, .notebookbar p {
        font-family: -apple-system, BlinkMacSystemFont, "Pretendard Variable", Pretendard, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif !important;
        font-size: 11px !important;
        font-weight: 500 !important;
        line-height: 1.25 !important;
      }
      .main-nav .ui-tab {
        font-size: 12px !important;
        font-weight: 500 !important;
      }
      .navigation-header {
        font-size: 12px !important;
        font-weight: 600 !important;
        height: 32px !important;
        padding: 4px 8px !important;
      }
      .navigation-header .navigation-title {
        display: none !important;
      }
    `;
    if (document.head) document.head.appendChild(style);

    const fixPaste = () => {
      const pasteButtons = document.querySelectorAll(
        "#Home-container button, .notebookbar button, #buttonpaste",
      );
      for (const btn of pasteButtons) {
        if (btn.textContent && btn.textContent.includes("Paste")) {
          btn.innerHTML = btn.innerHTML.replace(/\bPaste\b/g, "붙여넣기");
        }
      }
    };
    fixPaste();
    const pasteObserver = new MutationObserver(fixPaste);
    if (document.body) {
      pasteObserver.observe(document.body, { childList: true, subtree: true });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyTypography);
  } else {
    applyTypography();
  }

  const extensionId = "org.spellbook.editor";
  let requested = false;
  let attempts = 0;
  let timer;
  const rootClass = "spellbook-extension-bridge-active";
  const panelSelector =
    '.extension-panel[data-extension-id="org.spellbook.editor"]';

  function synchronizeBridgeVisibility() {
    const active = Boolean(document.querySelector(panelSelector));
    const changed =
      document.documentElement.classList.contains(rootClass) !== active;
    document.documentElement.classList.toggle(rootClass, active);
    if (changed)
      requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  }

  new MutationObserver(synchronizeBridgeVisibility).observe(
    document.documentElement,
    { childList: true, subtree: true },
  );
  synchronizeBridgeVisibility();

  function openExtension() {
    if (!requested) return;
    const control = globalThis.app?.map?._extensions?.[extensionId];
    if (control) {
      attempts = 0;
      if (!control._panel) control.toggle();
      synchronizeBridgeVisibility();
      return;
    }
    if (attempts++ < 120) timer = setTimeout(openExtension, 250);
  }

  // Phones open documents in the editor's view mode, where neither saves nor
  // AI edits apply. The host asks for edit mode when it needs the document
  // writable; switching this way does not focus the page or open a keyboard.
  function ensureEditMode(origin) {
    const map = globalThis.app?.map;
    if (
      map?.isReadOnlyMode?.() &&
      !globalThis.app?.file?.readOnly &&
      typeof map._enterEditMode === "function"
    ) {
      document
        .getElementById("mobile-edit-button")
        ?.style.setProperty("display", "none");
      map._enterEditMode("edit");
    }
    window.parent.postMessage(
      { type: "spellbook.edit-mode", edit: Boolean(map?.isEditMode?.()) },
      origin,
    );
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const expectedOrigin = globalThis.app?.map?.wopi?.PostMessageOrigin;
    if (expectedOrigin && event.origin !== expectedOrigin) return;
    if (event.data?.type === "spellbook.ensure-edit") {
      ensureEditMode(event.origin);
      return;
    }
    if (event.data?.type !== "spellbook.open-extension") return;
    requested = true;
    clearTimeout(timer);
    openExtension();
  });
})();
