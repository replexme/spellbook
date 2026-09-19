"use client";

import { Fragment, type ReactNode } from "react";
import { Button, Icon } from "@/design-system";
import { timeRange } from "../copy";
import { ScopeChip } from "./composer";
import type { ConversationItem } from "./conversation";
import type { CardTurn } from "./result-card";

/** Requests, result cards, direct-edit lines and notices, in time order. */
export function ConversationLog({
  items,
  renderTurn,
  onCancelQueued,
}: {
  items: ConversationItem[];
  renderTurn: (turn: CardTurn) => ReactNode;
  onCancelQueued?: () => void;
}) {
  return (
    <div className="ws-log" role="log" aria-label="AI 요청과 결과">
      {items.map((item) =>
        item.kind === "user" ? (
          <div
            key={item.key}
            className={`msg-user ${item.queued ? "is-queued" : ""}`}
          >
            <p>{item.text}</p>
            {item.queued ? (
              <p className="msg-queued" role="status">
                <span className="ds-spinner" aria-hidden="true" />
                <span>편집기가 열리는 대로 보낼게요</span>
                {onCancelQueued ? (
                  <Button size="sm" variant="quiet" onClick={onCancelQueued}>
                    취소
                  </Button>
                ) : null}
              </p>
            ) : (
              <ScopeChip mode={item.permission} />
            )}
          </div>
        ) : item.kind === "system" ? (
          <p key={item.key} className="msg-system">
            {item.text}
          </p>
        ) : item.kind === "manual" ? (
          <p key={item.key} className="msg-system is-manual">
            <Icon name="edit" size={13} />
            직접 수정함 · {timeRange(item.run.from, item.run.to)}
          </p>
        ) : (
          <Fragment key={item.key}>{renderTurn(item.turn)}</Fragment>
        ),
      )}
    </div>
  );
}
