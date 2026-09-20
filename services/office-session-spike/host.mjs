// Local-only architecture probe. Never mount this server as a production route.
import { createServer } from "node:http";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { probeAssetForId } from "./probe-assets.mjs";

const MAX_BYTES = 50_000_000;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const escapeHtml = (s) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

export async function createProbe({
  source,
  output,
  editorOrigin = "http://localhost:9980",
  port = 3190,
  native = false,
  nativeProbe = false,
  fileId = "probe",
}) {
  const origin = new URL(editorOrigin);
  if (
    !["localhost", "127.0.0.1"].includes(origin.hostname) ||
    origin.protocol !== "http:"
  )
    throw new Error("The probe accepts only a local HTTP editor.");
  if (!/^[a-z0-9-]{1,64}$/i.test(fileId))
    throw new Error("The probe fileId must be 1-64 URL-safe characters.");
  if (nativeProbe && !native)
    throw new Error("The native probe surface requires a native session.");
  const wopiFilePath = `/wopi/files/${fileId}`;
  const original = await readFile(source);
  if (
    original.length > MAX_BYTES ||
    original.subarray(0, 2).toString() !== "PK"
  )
    throw new Error("Expected a PPTX smaller than 50 MB.");
  await mkdir(output, { recursive: false });
  await writeFile(path.join(output, "original.pptx"), original, { flag: "wx" });
  let current = original;
  let version = 0;
  let saving = false;
  const token = randomBytes(32).toString("hex");
  const expiresAt = Date.now() + 60 * 60 * 1000;
  const events = [];
  const nativeHarness = native
    ? (await import("./native-harness.mjs")).createNativeHarness({
        probeEnabled: nativeProbe,
      })
    : null;
  const receipt = () => ({
    sourceSha256: sha(original),
    currentSha256: sha(current),
    version,
    events,
  });
  const record = async (type, values = {}) => {
    events.push({ at: new Date().toISOString(), type, ...values });
    await writeFile(
      path.join(output, "receipt.json"),
      JSON.stringify(receipt(), null, 2),
    );
  };
  const authorized = (url, req) => {
    const candidate =
      url.searchParams.get("access_token") ??
      req.headers.authorization?.replace(/^Bearer /, "") ??
      "";
    const bytes = Buffer.from(candidate);
    return (
      Date.now() < expiresAt &&
      bytes.length === token.length &&
      timingSafeEqual(bytes, Buffer.from(token))
    );
  };
  const server = createServer(async (req, res) => {
    const reply = (status, data, type = "application/json") => {
      res.writeHead(status, {
        "content-type": type,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(
        typeof data === "object" && !Buffer.isBuffer(data)
          ? JSON.stringify(data)
          : data,
      );
    };
    try {
      // Bind loopback, and also reject DNS rebinding / unexpected Host headers.
      const activePort = server.address()?.port ?? port;
      const allowedHosts = [
        `localhost:${activePort}`,
        `127.0.0.1:${activePort}`,
        `host.docker.internal:${activePort}`,
      ];
      if (!allowedHosts.includes(req.headers.host))
        return reply(403, { error: "host" });
      const url = new URL(req.url, `http://localhost:${activePort}`);
      if (url.pathname === "/generated.png" && req.method === "GET") {
        return reply(
          200,
          await readFile(
            new URL(
              "../../.tmp-runtime-validation/codex-image-generation/generated.png",
              import.meta.url,
            ),
          ),
          "image/png",
        );
      }
      const probeAssetMatch = native
        ? /^\/api\/documents\/probe\/assets\/([0-9a-f-]{36})$/i.exec(
            url.pathname,
          )
        : null;
      if (probeAssetMatch && req.method === "GET") {
        const asset = probeAssetForId(probeAssetMatch[1]);
        if (asset) return reply(200, asset.bytes, asset.mediaType);
        return reply(404, { error: "asset_not_found" });
      }
      if (
        native &&
        /^\/api\/wopi\/files\/probe\/assets\/[0-9a-f-]{36}$/i.test(
          url.pathname,
        ) &&
        req.method === "GET"
      ) {
        if (!authorized(url, req))
          return reply(401, { error: "expired or invalid token" });
        return reply(
          200,
          await readFile(
            new URL(
              "../../.tmp-runtime-validation/codex-image-generation/generated.png",
              import.meta.url,
            ),
          ),
          "image/png",
        );
      }
      if (
        native &&
        url.pathname === "/api/ai/account/status" &&
        req.method === "GET"
      ) {
        return reply(200, {
          account: {
            account: process.env.SPELLBOOK_NATIVE_AI_HOME
              ? { type: "chatgpt", email: "local-probe" }
              : null,
          },
        });
      }
      if (
        native &&
        ["/workspace.js", "/workspace.css"].includes(url.pathname) &&
        req.method === "GET"
      ) {
        return reply(
          200,
          await readFile(
            new URL(
              `../office-editor/workspace-dist${url.pathname}`,
              import.meta.url,
            ),
          ),
          url.pathname.endsWith(".js") ? "text/javascript" : "text/css",
        );
      }
      if (url.pathname === "/" && req.method === "GET") {
        const discovery = await fetch(`${origin.origin}/hosting/discovery`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!discovery.ok) throw new Error("Editor discovery failed.");
        const xml = await discovery.text();
        const action = [...xml.matchAll(/<action\b[^>]*>/g)]
          .map(([tag]) =>
            Object.fromEntries(
              [...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, k, v]) => [
                k,
                v.replaceAll("&amp;", "&"),
              ]),
            ),
          )
          .find((a) => a.ext === "pptx" && a.name === "edit");
        if (!action) throw new Error("Editor does not advertise PPTX editing.");
        const editorUrl = new URL(action.urlsrc);
        if (editorUrl.origin !== origin.origin)
          throw new Error("Unexpected discovery origin.");
        editorUrl.search = "";
        editorUrl.searchParams.set("lang", "ko-KR");
        editorUrl.searchParams.set("ui", "ko-KR");
        editorUrl.searchParams.set("rs", "ko-KR");
        editorUrl.searchParams.set(
          "WOPISrc",
          `http://host.docker.internal:${activePort}${wopiFilePath}`,
        );
        await record("editor-open");
        if (native) {
          const launch = JSON.stringify({
            documentId: "probe",
            fileName: path.basename(source),
            editorKind: "wopi",
            editorUrl: editorUrl.href,
            accessToken: token,
            expiresAt,
            apiBase: "/native",
            // The product workspace requires an explicit connector mode. The
            // isolated conformance host exercises the built-in loopback AI
            // stub, so it uses the same internal mode as a hosted session.
            aiConnector: { mode: "internal" },
          }).replaceAll("<", "\\u003c");
          return reply(
            200,
            `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Spellbook</title><link rel="stylesheet" href="/workspace.css"><div id="root"></div><script>window.__spellbookLaunch=${launch}</script><script src="/workspace.js"></script></html>`,
            "text/html; charset=utf-8",
          );
        }
        return reply(
          200,
          `<!doctype html><html lang="ko"><meta charset="utf-8"><title>Spellbook · 편집 엔진 검증</title>
<style>*{box-sizing:border-box}body{margin:0;font:14px system-ui;background:#f5f5f5}header{height:48px;display:flex;align-items:center;gap:16px;padding:0 16px;border-bottom:1px solid #ddd}header strong{margin-right:auto}button{padding:5px 12px}iframe{display:block;width:100%;height:calc(100vh - 48px);border:0}#status{font-size:12px;color:#555}</style>
<header><strong>Spellbook · ${escapeHtml(path.basename(source))}</strong><span id="status">편집기 연결 중</span><button id="save">저장 검증</button><button id="undo">되돌리기</button><button id="redo">다시 실행</button></header>
<form id="launch" target="office" method="post" action="${escapeHtml(editorUrl.href)}"><input type="hidden" name="access_token" value="${token}"><input type="hidden" name="access_token_ttl" value="${expiresAt}"></form>
<iframe name="office" id="office" title="PPT 편집기" allow="clipboard-read; clipboard-write"></iframe>
<script>
const office=document.getElementById('office'),status=document.getElementById('status');
const editorOrigin=${JSON.stringify(origin.origin)};
function send(MessageId,Values={}){office.contentWindow.postMessage(JSON.stringify({MessageId,SendTime:Date.now(),Values}),editorOrigin)}
window.addEventListener('message',e=>{if(e.origin!==editorOrigin||e.source!==office.contentWindow)return;let m;try{m=typeof e.data==='string'?JSON.parse(e.data):e.data}catch{return}
if(m.MessageId==='App_LoadingStatus'){send('Host_PostmessageReady');status.textContent=m.Values?.Status==='Document_Loaded'?'편집 가능':m.Values?.Status||'연결 중'}
if(m.MessageId==='Action_Save_Resp')status.textContent=m.Values?.success?'저장 완료':'저장 응답 확인 필요';
});
document.getElementById('save').onclick=()=>{status.textContent='저장 중';send('Action_Save',{Notify:true,DontSaveIfUnmodified:false})};
document.getElementById('undo').onclick=()=>send('Send_UNO_Command',{Command:'.uno:Undo'});
document.getElementById('redo').onclick=()=>send('Send_UNO_Command',{Command:'.uno:Redo'});
office.onload=()=>send('Host_PostmessageReady');document.getElementById('launch').submit();
</script></html>`,
          "text/html; charset=utf-8",
        );
      }
      if (!authorized(url, req))
        return reply(401, { error: "expired or invalid token" });
      if (nativeHarness && (await nativeHarness.handle(url, req, reply)))
        return;
      if (url.pathname === "/settings" && req.method === "GET") {
        return reply(200, {
          extensions: [
            {
              uri: `http://host.docker.internal:${activePort}/extensions/org.spellbook.editor.zip?access_token=${token}`,
              stamp: sha(
                await readFile(
                  new URL("../office-editor/extension.zip", import.meta.url),
                ),
              ),
            },
          ],
        });
      }
      if (
        url.pathname === "/extensions/org.spellbook.editor.zip" &&
        req.method === "GET"
      ) {
        return reply(
          200,
          await readFile(
            new URL("../office-editor/extension.zip", import.meta.url),
          ),
          "application/zip",
        );
      }
      if (url.pathname === wopiFilePath && req.method === "GET") {
        await record("check-file-info");
        return reply(200, {
          BaseFileName: path.basename(
            source instanceof URL ? fileURLToPath(source) : source,
          ),
          UserSettings: JSON.stringify({
            uri: `http://host.docker.internal:${activePort}/settings?access_token=${token}`,
          }),
          OwnerId: "local-probe",
          UserId: "local-probe",
          UserFriendlyName: "Spellbook 검증",
          UserPreferredLanguage: "ko-KR",
          Size: current.length,
          Version: String(version),
          UserCanWrite: true,
          SupportsUpdate: true,
          SupportsLocks: false,
          PostMessageOrigin: `http://localhost:${activePort}`,
          EnableOwnerTermination: true,
          HideUserList: "true",
          DisableCopy: false,
          DisableExport: false,
          DisablePrint: false,
        });
      }
      if (url.pathname === `${wopiFilePath}/contents` && req.method === "GET") {
        await record("get-file", { version });
        return reply(
          200,
          current,
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        );
      }
      if (
        url.pathname === `${wopiFilePath}/contents` &&
        req.method === "POST" &&
        req.headers["x-wopi-override"] === "PUT"
      ) {
        if (saving) return reply(409, { error: "save already in progress" });
        saving = true;
        try {
          const chunks = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > MAX_BYTES) return reply(413, { error: "too large" });
            chunks.push(chunk);
          }
          const candidate = Buffer.concat(chunks);
          if (candidate.subarray(0, 2).toString() !== "PK")
            return reply(400, { error: "not a PPTX package" });
          const nextVersion = version + 1;
          await writeFile(
            path.join(output, `saved-${nextVersion}.pptx`),
            candidate,
            { flag: "wx" },
          );
          current = candidate;
          version = nextVersion;
          await record("put-file", { version, bytes: size });
          res.setHeader("X-WOPI-ItemVersion", String(version));
          return reply(200, { LastModifiedTime: new Date().toISOString() });
        } finally {
          saving = false;
        }
      }
      return reply(404, { error: "not found" });
    } catch (error) {
      reply(500, { error: error.message });
    }
  });
  await record("probe-created");
  server.on("close", () => void nativeHarness?.close());
  return { server, token, receipt };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [source, output, fileId = "probe"] = process.argv.slice(2);
  if (!source || !output)
    throw new Error(
      "Usage: node host.mjs SOURCE.pptx NEW_OUTPUT_DIRECTORY [UNIQUE_FILE_ID]",
    );
  const probe = await createProbe({
    source,
    output,
    native: true,
    nativeProbe: true,
    fileId,
  });
  probe.server.listen(3190, "127.0.0.1", () =>
    console.log(
      "Local editor probe: http://localhost:3190 (one-hour session; original is never overwritten)",
    ),
  );
}
