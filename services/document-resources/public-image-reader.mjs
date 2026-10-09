/* SPDX-License-Identifier: MPL-2.0 */
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isPublicAddress } from "./public-address.mjs";
import { inspectExternalRaster } from "../browser-office/external-raster.mjs";
const maxImageBytes = 5_000_000;
async function abortable(work, signal) {
  signal.throwIfAborted();
  let cancel;
  const stopped = new Promise((_, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(work), stopped]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

function publicUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw Error("external_image_uri_invalid");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    url.href.length > 2048 ||
    /(?:^|\.)(?:localhost|local|internal)$/.test(hostname)
  )
    throw Error("external_image_uri_not_public_http");
  return url;
}

// Resolve and pin every hop. In particular, a redirect cannot switch an
// admitted public URL to the service's private network or change DNS at connect.
export async function fetchLinkedPublicImage(
  raw,
  { signal, timeoutMs = 10_000 } = {},
) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let url = publicUrl(raw);
  for (let hop = 0; hop <= 3; hop++) {
    bounded.throwIfAborted();
    const addresses = await abortable(
      () =>
        lookup(url.hostname.replace(/^\[|\]$/g, ""), {
          all: true,
          verbatim: true,
        }),
      bounded,
    );
    if (
      !addresses.length ||
      addresses.some((item) => !isPublicAddress(item.address))
    )
      throw Error("external_image_destination_not_public");
    const response = await new Promise((resolve, reject) => {
      const request = (url.protocol === "https:" ? https : http).get(
        url,
        {
          signal: bounded,
          agent: false,
          headers: {
            accept: "image/png,image/jpeg,image/gif",
            "accept-encoding": "identity",
            "user-agent": "Spellbook-Document-Resources/1.0",
          },
          lookup: (hostname, options, callback) => {
            if (hostname !== url.hostname.replace(/^\[|\]$/g, ""))
              return callback(Error("external_image_dns_host_mismatch"));
            if (options.all) callback(null, addresses);
            else callback(null, addresses[0].address, addresses[0].family);
          },
        },
        resolve,
      );
      request.once("error", reject);
    });
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      const target = response.headers.location;
      response.destroy();
      if (hop === 3 || !target) throw Error("external_image_redirect_limit");
      url = publicUrl(new URL(target, url).href);
      continue;
    }
    if (response.statusCode !== 200) {
      response.destroy();
      throw Error("external_image_http_" + response.statusCode);
    }
    if (Number(response.headers["content-length"]) > maxImageBytes) {
      response.destroy();
      throw Error("external_image_payload_size_invalid");
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response) {
      size += chunk.length;
      if (size > maxImageBytes) {
        response.destroy();
        throw Error("external_image_payload_size_invalid");
      }
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    inspectExternalRaster(bytes);
    return bytes;
  }
  throw Error("external_image_redirect_limit");
}
