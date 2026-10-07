import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { WorkspaceTopBar, saveView } from "./top-bar";

it("offers an actionable save after incomplete review, rather than an endless busy indicator", () => {
  const noop = () => {};
  const markup = renderToStaticMarkup(
    <WorkspaceTopBar
      fileName="example.pptx"
      save={saveView("AI 변경 확인 필요", true, null)}
      onSave={noop}
      editorReady={true}
      onUndo={noop}
      onRedo={noop}
      versionsOpen={false}
      onVersions={noop}
      onDownload={noop}
      panelOpen={true}
      onTogglePanel={noop}
    />,
  );
  expect(markup).toMatch(/<button[^>]*class="ws-save is-dirty"[^>]*>/);
  expect(markup).toContain("AI 변경 확인 필요 · 지금 저장");
  expect(saveView("저장 중…", true, null).kind).toBe("busy");
});
