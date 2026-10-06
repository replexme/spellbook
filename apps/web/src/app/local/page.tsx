import { redirect } from "next/navigation";
import { browserOfficeLocalUrl } from "@/lib/browser-session";

export const dynamic = "force-dynamic";

export default function LocalFilePage() {
  // The document and file handle stay in the editor origin. The app shell
  // receives neither document bytes nor a capability to read the local file.
  redirect(browserOfficeLocalUrl());
}
