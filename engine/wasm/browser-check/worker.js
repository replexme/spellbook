// The engine in a Web Worker: init, fonts, open, render, and the AI bridge
// contract (invoke). Each request carries an id; the reply echoes it.
import init, { Engine } from "./glue/present_engine_wasm.js";

let engine;
onmessage = async ({ data: m }) => {
  const t = performance.now();
  try {
    let reply = {};
    let transfer = [];
    if (m.type === "init") {
      await init();
      engine = new Engine();
    } else if (m.type === "fonts") {
      for (const b of m.fonts) engine.add_font(new Uint8Array(b));
    } else if (m.type === "open") {
      reply.slides = engine.open(new Uint8Array(m.bytes));
    } else if (m.type === "render") {
      const png = engine.render(m.slide, m.scale);
      reply = { png, layout: engine.layout(m.slide) };
      transfer = [png.buffer];
    } else if (m.type === "invoke") {
      reply.reply = engine.invoke(m.input);
    }
    postMessage({ id: m.id, ms: performance.now() - t, ...reply }, transfer);
  } catch (e) {
    postMessage({ id: m.id, error: String(e) });
  }
};
