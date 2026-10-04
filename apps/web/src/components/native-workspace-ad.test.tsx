import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Stands in for the managed service's ad strip, which replaces the empty
// self-hosted module at build time.
vi.mock("./workspace/workspace-ad", () => ({
  workspaceAdEnabled: true,
  WorkspaceAd: () => <aside className="ws-ad">ad strip</aside>,
}));

const { NativeWorkspace } = await import("./native-workspace");

const launch = {
  editorKind: "wopi" as const,
  documentId: "doc-1",
  fileName: "deck.pptx",
  editorUrl: "https://office.example.test/editor",
  accessToken: "token",
  expiresAt: Date.now() + 60_000,
  apiBase: "/api/documents/doc-1",
  aiConnector: { mode: "internal" as const },
};

describe("workspace ad strip and the account plan", () => {
  it("shows the strip and reserves its row only when the plan shows ads", () => {
    const withAds = renderToStaticMarkup(
      <NativeWorkspace launch={launch} showAds />,
    );
    expect(withAds).toContain("ws-ad");
    expect(withAds).toMatch(/class="ws [^"]*has-ad/);
  });

  it("shows no strip and no empty row for a plan without ads", () => {
    for (const markup of [
      renderToStaticMarkup(<NativeWorkspace launch={launch} showAds={false} />),
      renderToStaticMarkup(<NativeWorkspace launch={launch} />),
    ]) {
      expect(markup).not.toContain("ws-ad");
      expect(markup).not.toContain("has-ad");
    }
  });
});
