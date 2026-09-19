import { notFound } from "next/navigation";

import { DesignGallery } from "@/components/design-gallery";

export const dynamic = "force-dynamic";

/** The system's own gallery: open in development, or when explicitly enabled. */
export default function DesignSystemPage() {
  if (
    process.env.NODE_ENV === "production" &&
    process.env.SPELLBOOK_DESIGN_GALLERY !== "1"
  )
    notFound();
  return <DesignGallery />;
}
