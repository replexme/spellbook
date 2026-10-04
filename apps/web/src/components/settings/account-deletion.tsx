"use client";

import { useState } from "react";
import { Banner, Button, Dialog, TextField } from "@/design-system";
import type { AccountClosureInfo } from "@/lib/account-closure";
import { ACCOUNT_CLOSURE_CONFIRMATION } from "@/lib/account-closure-confirmation";
import { userFacingError } from "@/lib/user-errors";

type State =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "accepted" }
  | { kind: "blocked" }
  | { kind: "failed"; message: string };

/**
 * Closing the account from settings: what is deleted is listed before
 * anything happens, and the person types a word to confirm.
 */
export function AccountDeletion({ info }: { info: AccountClosureInfo }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });
  const confirmed = typed.trim() === ACCOUNT_CLOSURE_CONFIRMATION;

  const close = () => {
    if (state.kind === "sending") return;
    if (state.kind === "accepted") {
      window.location.assign("/");
      return;
    }
    setOpen(false);
    setTyped("");
    setState({ kind: "idle" });
  };

  const submit = async () => {
    if (!confirmed) return;
    setState({ kind: "sending" });
    try {
      const response = await fetch("/api/account/deletion", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: ACCOUNT_CLOSURE_CONFIRMATION }),
        cache: "no-store",
      });
      const body = (await response.json().catch(() => ({}))) as {
        status?: string;
        error?: string;
      };
      if (body.status === "accepted") setState({ kind: "accepted" });
      else if (body.status === "blocked") setState({ kind: "blocked" });
      else
        setState({
          kind: "failed",
          message: userFacingError(
            body.error,
            "계정 삭제를 요청하지 못했어요. 잠시 뒤 다시 시도해 주세요.",
          ),
        });
    } catch {
      setState({
        kind: "failed",
        message: "인터넷 연결을 확인한 뒤 다시 시도해 주세요.",
      });
    }
  };

  return (
    <div className="account-deletion">
      <div>
        <strong>계정 삭제</strong>
        <small>
          계정과 저장한 파일, 버전 기록, AI 연결 정보를 모두 지워요. 지운 뒤에는
          되돌릴 수 없어요.
        </small>
      </div>
      <Button variant="danger-quiet" size="sm" onClick={() => setOpen(true)}>
        계정 삭제
      </Button>
      <Dialog
        open={open}
        title={
          state.kind === "accepted" ? "삭제를 요청했어요" : "계정을 삭제할까요?"
        }
        onClose={close}
        dismissible={state.kind !== "sending"}
        footer={
          state.kind === "accepted" ? (
            <Button variant="primary" onClick={close}>
              확인
            </Button>
          ) : state.kind === "blocked" ? (
            <Button onClick={close}>닫기</Button>
          ) : (
            <>
              <Button onClick={close} disabled={state.kind === "sending"}>
                취소
              </Button>
              <Button
                variant="danger"
                disabled={!confirmed}
                loading={state.kind === "sending"}
                onClick={() => void submit()}
              >
                영구 삭제
              </Button>
            </>
          )
        }
      >
        {state.kind === "accepted" ? (
          <>
            <p className="dialog-lead">
              이 브라우저에서 로그아웃했어요. 문서와 기록은 보통 1시간 안에
              지워져요.
            </p>
            <p className="dialog-note">
              다시 로그인하면 빈 새 계정으로 시작해요.
            </p>
          </>
        ) : state.kind === "blocked" ? (
          <Banner tone="warn" role="alert">
            이 계정은 여기서 삭제할 수 없어요. 운영자 계정이거나 삭제를 막아 둔
            계정이에요. 문의하기로 알려 주세요.
          </Banner>
        ) : (
          <>
            <p className="dialog-lead">삭제하면 다음을 지워요.</p>
            <ul className="account-deletion-list">
              {info.deletes.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            {info.notes.map((line) => (
              <p key={line} className="dialog-note">
                {line}
              </p>
            ))}
            <p className="dialog-note">
              필요한 파일은 먼저 내려받아 두세요. 삭제한 뒤에는 되돌릴 수
              없어요.
            </p>
            <TextField
              label={`확인을 위해 ‘${ACCOUNT_CLOSURE_CONFIRMATION}’를 입력해 주세요`}
              value={typed}
              autoComplete="off"
              onChange={(event) => setTyped(event.target.value)}
              disabled={state.kind === "sending"}
            />
            {state.kind === "failed" ? (
              <Banner tone="danger" role="alert">
                {state.message}
              </Banner>
            ) : null}
          </>
        )}
      </Dialog>
    </div>
  );
}
