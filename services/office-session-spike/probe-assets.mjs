// Local conformance fixtures shared by the Collabora and browser Office probes.
// Never expose these routes outside a probe session.
export const PROBE_IMAGE_ASSET_ID = "00000000-0000-4000-8000-000000000001";
export const PROBE_MEDIA_ASSET_ID = "00000000-0000-4000-8000-000000000002";
export const PROBE_REPLACEMENT_IMAGE_ASSET_ID =
  "00000000-0000-4000-8000-000000000003";
export const PROBE_REPLACEMENT_MEDIA_ASSET_ID =
  "00000000-0000-4000-8000-000000000004";

const probeWav = (sampleValue) => {
  const sampleRate = 8000;
  const samples = sampleRate / 4;
  const bytes = Buffer.alloc(44 + samples);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate, 28);
  bytes.writeUInt16LE(1, 32);
  bytes.writeUInt16LE(8, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(samples, 40);
  bytes.fill(sampleValue, 44);
  return bytes;
};

export const probeAssets = new Map([
  [
    PROBE_IMAGE_ASSET_ID,
    {
      mediaType: "image/png",
      bytes: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    },
  ],
  [PROBE_MEDIA_ASSET_ID, { mediaType: "audio/wav", bytes: probeWav(128) }],
  [
    PROBE_REPLACEMENT_IMAGE_ASSET_ID,
    {
      mediaType: "image/png",
      bytes: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADklEQVQImWP4z8DwH4QBEfcD/RSF9bkAAAAASUVORK5CYII=",
        "base64",
      ),
    },
  ],
  [
    PROBE_REPLACEMENT_MEDIA_ASSET_ID,
    { mediaType: "audio/wav", bytes: probeWav(160) },
  ],
]);

export function probeAssetForId(assetId) {
  return typeof assetId === "string"
    ? (probeAssets.get(assetId.toLowerCase()) ?? null)
    : null;
}
