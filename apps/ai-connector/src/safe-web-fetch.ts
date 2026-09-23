import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { Agent, fetch } from "undici";

const MAX_BODY_BYTES = 1_000_000;

/** No browser credentials or internal destinations may cross this boundary. */
export function isPublicAddress(address: string): boolean {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}

export async function fetchPublicPage(rawUrl: string, signal?: AbortSignal): Promise<string> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (error) {
    throw new Error(`web_fetch_invalid_url: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (
    url.protocol !== "https:" || url.username || url.password || url.port ||
    url.href.length > 2048 ||
    /\.(?:local|internal|localhost)$/i.test(url.hostname) ||
    url.hostname.toLowerCase() === "localhost"
  ) throw new Error(`web_fetch_disallowed_url: ${url.origin}`);

  // Resolve once and pin the connection to precisely those verified addresses.
  // A second DNS lookup by the HTTP client would permit rebinding between check and use.
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address)))
    throw new Error(`web_fetch_non_public_address: ${url.hostname}`);

  const dispatcher = new Agent({
    connect: {
      lookup: (hostname, options, callback) => {
        if (hostname !== url.hostname) {
          callback(new Error("web_fetch_dns_host_mismatch"), "");
          return;
        }
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0]!.address, addresses[0]!.family);
      },
    },
  });
  try {
    const response = await fetch(url, {
      dispatcher,
      redirect: "error", // never follow a redirect to an unverified destination
      headers: { "user-agent": "Spellbook-AI-Agent/1.0", accept: "text/html,application/xhtml+xml,text/plain;q=0.9" },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`web_fetch_http_${response.status}: ${response.statusText}`);
    const length = Number(response.headers.get("content-length"));
    if (length > MAX_BODY_BYTES) throw new Error("web_fetch_response_too_large");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of response.body ?? []) {
      bytes += chunk.byteLength;
      if (bytes > MAX_BODY_BYTES) throw new Error("web_fetch_response_too_large");
      chunks.push(chunk);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  } finally {
    await dispatcher.destroy();
  }
}
