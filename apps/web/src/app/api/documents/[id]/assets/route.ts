import { requireSession, routeError } from "@/lib/http";
import { ASSET_UPLOAD_MAX_BYTES, uploadAsset } from "@/lib/image-assets";
import { assertStorageAvailable } from "@/lib/storage-usage";

const multipartOverheadAllowance = 100_000;

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireSession(request);
    if (
      Number(request.headers.get("content-length")) >
      ASSET_UPLOAD_MAX_BYTES + multipartOverheadAllowance
    )
      return Response.json({ error: "asset_too_large" }, { status: 413 });
    const reader = request.body?.getReader();
    if (!reader)
      return Response.json({ error: "file_required" }, { status: 400 });
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > ASSET_UPLOAD_MAX_BYTES + multipartOverheadAllowance) {
        await reader.cancel();
        return Response.json({ error: "asset_too_large" }, { status: 413 });
      }
      chunks.push(item.value);
    }
    const file = (
      await new Response(Buffer.concat(chunks), {
        headers: { "content-type": request.headers.get("content-type") ?? "" },
      }).formData()
    ).get("file");
    if (!(file instanceof File))
      return Response.json({ error: "file_required" }, { status: 400 });
    await assertStorageAvailable(session, { addingBytes: file.size });
    return Response.json(
      await uploadAsset(session, (await context.params).id, file),
      { status: 201 },
    );
  } catch (error) {
    return routeError(error);
  }
}
