import type { Metadata } from "next";
import { ButtonLink } from "@/design-system";
import { StatusScreen } from "@/components/status-screen";

export const metadata: Metadata = {
  title: "페이지를 찾을 수 없어요 — Spellbook",
};

export default function NotFound() {
  return (
    <StatusScreen
      icon="search"
      title="페이지를 찾을 수 없어요"
      support={{ place: "없는 페이지" }}
      actions={
        <ButtonLink variant="primary" icon="home" href="/">
          파일 목록으로
        </ButtonLink>
      }
    >
      <p>
        주소가 바뀌었거나 삭제된 페이지예요. 파일은 파일 목록에서 다시 열 수
        있어요.
      </p>
    </StatusScreen>
  );
}
