import { browserOfficeLicensesUrl } from "@/lib/browser-session";

export const dynamic = "force-dynamic";

// The browser editor's open-source notice lives with the editor it
// describes; without it the repository's notices apply.
export function GET() {
  return Response.redirect(
    browserOfficeLicensesUrl() ??
      "https://github.com/replexme/spellbook/blob/main/THIRD_PARTY_NOTICES.md",
    302,
  );
}
