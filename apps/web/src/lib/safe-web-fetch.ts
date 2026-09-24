import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { Agent, fetch } from "undici";

/*
 * Reads one public web page for an AI request. Same rules as the AI
 * connector's reader: HTTPS only, public addresses only, no redirects, 1 MB.
 */

const MAX_BODY_BYTES = 1_000_000;
const MAX_TEXT_CHARACTERS = 10_000;

/** No browser credentials or internal destinations may cross this boundary. */
export function isPublicAddress(address: string): boolean {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}

export async function fetchPublicPage(
  rawUrl: string,
  signal?: AbortSignal,
): Promise<string> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("web_fetch_invalid_url");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.href.length > 2048 ||
    /\.(?:local|internal|localhost)$/i.test(url.hostname) ||
    url.hostname.toLowerCase() === "localhost"
  )
    throw new Error(`web_fetch_disallowed_url: ${url.origin}`);

  // Resolve once and pin the connection to exactly those checked addresses:
  // a second DNS lookup by the HTTP client would permit rebinding.
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (
    !addresses.length ||
    addresses.some(({ address }) => !isPublicAddress(address))
  )
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
    const timeout = AbortSignal.timeout(15_000);
    const response = await fetch(url, {
      dispatcher,
      redirect: "error",
      headers: {
        "user-agent": "Spellbook-AI-Agent/1.0",
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
      },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) throw new Error(`web_fetch_http_${response.status}`);
    if (Number(response.headers.get("content-length")) > MAX_BODY_BYTES)
      throw new Error("web_fetch_response_too_large");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of response.body ?? []) {
      bytes += chunk.byteLength;
      if (bytes > MAX_BODY_BYTES)
        throw new Error("web_fetch_response_too_large");
      chunks.push(chunk);
    }
    return new TextDecoder().decode(Buffer.concat(chunks));
  } finally {
    await dispatcher.destroy();
  }
}

/** The readable text of a page, without scripts, styles and navigation. */
export function pageText(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, "")
    .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, "")
    .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT_CHARACTERS);
}
