"use client";

import { useEffect, useState } from "react";
import { Button, ButtonLink } from "@/design-system";
import { StatusScreen } from "@/components/status-screen";
import { reportClientError } from "@/lib/report-client-error";
import { newErrorReference } from "@/lib/support";

/** A page failed to render: say so in Korean and offer a way forward. */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [reference, setReference] = useState<string | null>(null);
  useEffect(() => {
    reportClientError(error);
    setReference(error.digest?.slice(0, 12) || newErrorReference());
  }, [error]);
  return (
    <StatusScreen
      title="화면을 보여 주지 못했어요"
      reference={reference}
      support={{ place: "오류 화면" }}
      actions={
        <>
          <Button variant="primary" icon="refresh" onClick={reset}>
            다시 시도
          </Button>
          <ButtonLink icon="home" href="/">
            파일 목록으로
          </ButtonLink>
        </>
      }
    >
      <p>
        예상하지 못한 문제가 생겼어요. 저장된 파일은 그대로 있어요. 다시
        시도해도 같은 화면이 나오면 아래 오류 번호와 함께 알려 주세요.
      </p>
    </StatusScreen>
  );
}
