import { afterEach, describe, expect, it, vi } from "vitest";

import {
  browserOfficeLicensesUrl,
  browserOfficeWorkspaceUrl,
  browserRevision,
  requireBrowserOrigin,
} from "./browser-session";

afterEach(() => vi.unstubAllEnvs());

describe("browser edit session boundary", () => {
  it("uses one opaque ETag for the exact version and content digest", () => {
    expect(browserRevision("version-1", "A".repeat(64))).toBe(
      `"version-1:${"a".repeat(64)}"`,
    );
    expect(() => browserRevision("version-1", "short")).toThrow(
      "document_context_not_ready",
    );
  });

  it("accepts only the configured browser origin for a candidate mutation", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://spellbook.example");
    expect(() =>
      requireBrowserOrigin(
        new Request("https://spellbook.example/api/candidate", {
          headers: { origin: "https://spellbook.example" },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      requireBrowserOrigin(
        new Request("https://spellbook.example/api/candidate", {
          headers: { origin: "https://attacker.example" },
        }),
      ),
    ).toThrow("invalid_browser_origin");
  });

  it("binds the browser Office workspace to the exact product origin", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://spellbook.example");
    vi.stubEnv(
      "SPELLBOOK_BROWSER_OFFICE_URL",
      "https://office.spellbook.example",
    );
    expect(browserOfficeWorkspaceUrl()).toBe(
      "https://office.spellbook.example/workspace?hostOrigin=https%3A%2F%2Fspellbook.example",
    );
    vi.stubEnv(
      "SPELLBOOK_BROWSER_OFFICE_URL",
      "https://user:secret@office.spellbook.example",
    );
    expect(() => browserOfficeWorkspaceUrl()).toThrow(
      "SPELLBOOK_BROWSER_OFFICE_URL is invalid.",
    );
  });

  it("points to the editor's open-source notice once it is configured", () => {
    vi.stubEnv("SPELLBOOK_BROWSER_OFFICE_URL", "");
    expect(browserOfficeLicensesUrl()).toBeNull();
    vi.stubEnv(
      "SPELLBOOK_BROWSER_OFFICE_URL",
      "https://office.spellbook.example",
    );
    expect(browserOfficeLicensesUrl()).toBe(
      "https://office.spellbook.example/licenses",
    );
  });
});
