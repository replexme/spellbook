"use client";

import { useEffect, useState } from "react";
import "@/design-system/tokens.css";
import "@/design-system/base.css";
import "@/design-system/components.css";
import "@/design-system/patterns.css";
import { Button, ButtonLink } from "@/design-system";
import { StatusScreen } from "@/components/status-screen";
import { reportClientError } from "@/lib/report-client-error";
import { newErrorReference } from "@/lib/support";

/** The whole app failed, layout included: a complete Korean page. */
export default function GlobalError({
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
    <html lang="ko">
      <body>
        <StatusScreen
          title="Spellbook을 열지 못했어요"
          reference={reference}
          support={{ place: "전체 오류 화면" }}
          actions={
            <>
              <Button variant="primary" icon="refresh" onClick={reset}>
                다시 시도
              </Button>
              <ButtonLink icon="home" href="/">
                처음으로
              </ButtonLink>
            </>
          }
        >
          <p>
            예상하지 못한 문제가 생겼어요. 저장된 파일은 그대로 있어요. 잠시 뒤
            다시 시도해 주세요.
          </p>
        </StatusScreen>
      </body>
    </html>
  );
}
