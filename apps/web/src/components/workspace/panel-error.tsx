"use client";

import { useEffect, useMemo } from "react";
import { Banner, IconButton } from "@/design-system";
import { newErrorReference } from "@/lib/support";
import { reportEditorError } from "@/lib/editor-error-report";
import { UNEXPECTED_ERROR, userFacingError } from "@/lib/user-errors";
import { SupportLink } from "../status-screen";

/**
 * The editor panel's error line. Whatever was stored (a reason code, a
 * Korean sentence or exception text) is shown in plain Korean; a failure
 * nobody described also gets a number to quote and a way to report it.
 */
export function PanelError({
  error,
  link = null,
  documentId,
  onDismiss,
}: {
  error: string;
  /** A page that fixes the error (for example the plan section). */
  link?: { label: string; href: string } | null;
  documentId: string;
  onDismiss: () => void;
}) {
  const failure = useMemo(
    () => ({
      reference: newErrorReference(),
      occurredAt: new Date().toISOString(),
    }),
    [error],
  );
  const code = /^[a-z][a-z0-9_]{1,79}$/.test(error.trim())
    ? error.trim()
    : "unexpected_error";
  const reference = failure.reference;
  useEffect(() => {
    reportEditorError(documentId, reference, code, failure.occurredAt);
  }, [documentId, reference, code, failure.occurredAt]);
  return (
    <Banner
      tone="danger"
      role="alert"
      action={
        <IconButton
          icon="close"
          label="알림 닫기"
          size="sm"
          onClick={onDismiss}
        />
      }
    >
      {userFacingError(error, UNEXPECTED_ERROR)}
      {link ? (
        <>
          {" "}
          <a href={link.href}>{link.label}</a>
        </>
      ) : null}
      {reference ? (
        <span className="ds-tabular"> (오류 번호 {reference})</span>
      ) : null}{" "}
      <SupportLink
        context={{
          place: "편집 화면",
          documentId,
          errorReference: reference,
          errorCode: code,
          occurredAt: failure.occurredAt,
        }}
      >
        문제 신고
      </SupportLink>
    </Banner>
  );
}
