import type { Metadata } from "next";
import { ButtonLink } from "@/design-system";
import { StatusScreen } from "@/components/status-screen";
import { userFacingError } from "@/lib/user-errors";

export const metadata: Metadata = {
  title: "내려받지 못했어요 — Spellbook",
  robots: { index: false },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[a-z][a-z0-9_]{1,79}$/;

/** Where a failed download lands instead of a raw JSON error. */
export default async function DownloadErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ document?: string; reason?: string; ref?: string }>;
}) {
  const params = await searchParams;
  const documentId =
    params.document && UUID.test(params.document) ? params.document : null;
  const reason =
    params.reason && CODE.test(params.reason) ? params.reason : null;
  const reference =
    params.ref && /^[0-9A-F]{8}$/.test(params.ref) ? params.ref : null;
  const loginNeeded = reason === "login_required";
  return (
    <StatusScreen
      icon="download"
      title="파일을 내려받지 못했어요"
      reference={reference}
      support={{ place: "내려받기", documentId, errorCode: reason }}
      actions={
        loginNeeded ? (
          <ButtonLink variant="primary" href="/">
            다시 로그인
          </ButtonLink>
        ) : (
          <>
            {documentId ? (
              <ButtonLink
                variant="primary"
                icon="refresh"
                href={`/api/documents/${documentId}/download`}
              >
                다시 내려받기
              </ButtonLink>
            ) : null}
            <ButtonLink icon="home" href="/">
              파일 목록으로
            </ButtonLink>
          </>
        )
      }
    >
      <p>
        {userFacingError(
          reason,
          "잠시 문제가 생겼어요. 저장된 파일은 그대로 있어요.",
        )}
      </p>
      <p>잠시 뒤 다시 내려받아 보세요. 계속 안 되면 알려 주세요.</p>
    </StatusScreen>
  );
}
