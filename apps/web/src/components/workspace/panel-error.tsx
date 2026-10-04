"use client";

import { useMemo } from "react";
import { Banner, IconButton } from "@/design-system";
import { newErrorReference } from "@/lib/support";
import {
  UNEXPECTED_ERROR,
  errorNeedsReference,
  userFacingError,
} from "@/lib/user-errors";
import { SupportLink } from "../status-screen";

/**
 * The editor panel's error line. Whatever was stored (a reason code, a
 * Korean sentence or exception text) is shown in plain Korean; a failure
 * nobody described also gets a number to quote and a way to report it.
 */
export function PanelError({
  error,
  documentId,
  onDismiss,
}: {
  error: string;
  documentId: string;
  onDismiss: () => void;
}) {
  const needsReference = errorNeedsReference(error);
  // One number per distinct failure shown.
  const reference = useMemo(
    () => (needsReference ? newErrorReference() : null),
    [error, needsReference],
  );
  const code = /^[a-z][a-z0-9_]{1,79}$/.test(error.trim())
    ? error.trim()
    : null;
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
      {reference ? (
        <span className="ds-tabular"> (오류 번호 {reference})</span>
      ) : null}{" "}
      <SupportLink
        context={{
          place: "편집 화면",
          documentId,
          errorReference: reference,
          errorCode: code,
        }}
      >
        문제 신고
      </SupportLink>
    </Banner>
  );
}
