import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** Documents open in the browser document view. */
export default async function DocumentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/browser-documents/${encodeURIComponent(id)}`);
}
