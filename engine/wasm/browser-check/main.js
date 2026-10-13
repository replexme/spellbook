// Page half of the browser check (driven by run.mjs): a Worker running the
// engine, fonts from Local Font Access, and a text field whose IME input
// reaches the engine as one text edit per committed composition.
const worker = new Worker("./worker.js", { type: "module" });
let seq = 0;
const pending = new Map();
worker.onmessage = ({ data }) => {
  pending.get(data.id)(data);
  pending.delete(data.id);
};
const call = (msg, transfer = []) =>
  new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    worker.postMessage({ ...msg, id }, transfer);
  });

// Installed fonts (Local Font Access) whose family is one of `families`.
async function localFonts(families) {
  const all = await window.queryLocalFonts();
  const wanted = new Set(families.map((f) => f.toLowerCase()));
  const picked = all.filter((f) => wanted.has(f.family.toLowerCase()));
  const buffers = [];
  for (const f of picked) buffers.push(await (await f.blob()).arrayBuffer());
  return { count: all.length, families: [...new Set(all.map((f) => f.family))], picked: picked.map((f) => f.fullName), buffers };
}

// Text edits sent to the engine from the field: one per committed
// composition (compositionend) or plain input outside a composition.
const edits = [];
const field = document.getElementById("edit");
let target = null;
// Edits go one at a time: each expects the version the previous one made.
let lastSent = null;
let queue = Promise.resolve();
const send = () => (queue = queue.then(apply));
async function apply() {
  if (!target || field.value === lastSent) return;
  lastSent = field.value;
  edits.push(field.value);
  const input = JSON.stringify({
    abiVersion: 1,
    operation: "apply",
    parameters: {
      documentId: "doc",
      expectedVersion: String(target.version),
      transactionId: `edit-${edits.length}`,
      commands: [{ operation: "replace_text", targetId: target.targetId, parameters: { paragraphs: [field.value] } }],
    },
  });
  const r = JSON.parse((await call({ type: "invoke", input })).reply);
  if (r.result) target.version = Number(r.result.version);
  target.last = r;
}
field.addEventListener("compositionend", send);
field.addEventListener("input", (e) => {
  if (!e.isComposing) send();
});

window.check = { call, localFonts, edits, setTarget: (t) => (target = t), target: () => target };
