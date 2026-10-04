"use client";

import { useEffect, useState } from "react";
import { Button } from "@/design-system";
import { SupportLink } from "../status-screen";
import {
  EDITOR_SLOW_SECONDS,
  EDITOR_STUCK_SECONDS,
  editorLoadingMessage,
} from "./editor-loading-copy";
import { OpeningView } from "./opening";

/**
 * Fills the canvas until the browser editor is ready, counting the wait and
 * offering a retry and a report when it takes far longer than usual.
 */
export function EditorOpening({
  preview,
  previews,
  restoring,
  documentId,
  onRetry,
}: {
  preview: string | null;
  previews: Array<string | null>;
  restoring: boolean;
  documentId: string;
  onRetry?: () => void;
}) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (restoring) return;
    const startedAt = Date.now();
    setSeconds(0);
    const timer = setInterval(
      () => setSeconds(Math.floor((Date.now() - startedAt) / 1_000)),
      1_000,
    );
    return () => clearInterval(timer);
  }, [restoring]);
  if (restoring) return <OpeningView message="이전 버전을 불러오고 있어요" />;
  return (
    <OpeningView
      preview={preview}
      previews={previews}
      message={editorLoadingMessage(seconds)}
      action={
        seconds >= EDITOR_SLOW_SECONDS ? (
          <>
            <Button
              size="sm"
              icon="refresh"
              onClick={() => (onRetry ? onRetry() : window.location.reload())}
            >
              다시 시도
            </Button>
            {seconds >= EDITOR_STUCK_SECONDS ? (
              <SupportLink
                context={{
                  place: "편집기 열기",
                  documentId,
                  errorCode: "editor_open_timeout",
                }}
              >
                문제 신고
              </SupportLink>
            ) : null}
          </>
        ) : null
      }
    />
  );
}
