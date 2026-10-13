// WASM half of the native/WASM parity check, run under Node:
//   node engine/wasm/run-wasm.cjs <glue.js> <out-dir> <file.pptx> <font>...
const fs = require('node:fs');
const { Engine } = require(process.argv[2]);
const [out, pptx, ...fonts] = process.argv.slice(3);
const engine = new Engine();
for (const f of fonts) engine.add_font(fs.readFileSync(f));
const count = engine.open(fs.readFileSync(pptx));
fs.mkdirSync(out, { recursive: true });
for (let i = 1; i <= count; i++) {
  fs.writeFileSync(`${out}/slide-${i}.png`, engine.render(i, 1.0));
  fs.writeFileSync(`${out}/slide-${i}.json`, engine.layout(i));
}
