"use client";

import { useMemo, useState } from "react";
import {
  Badge,
  Banner,
  Button,
  EmptyState,
  Icon,
  SlideImage,
  Spinner,
} from "@/design-system";
import type { VersionHistoryItem } from "@/lib/history-types";
import { dayLabel, versionEntries, type VersionEntry } from "./version-entries";

export function VersionPanel({
  versions,
  loading,
  error,
  restoring,
  onRestore,
  onCompare,
  onReload,
}: {
  versions: VersionHistoryItem[];
  loading: boolean;
  error: string | null;
  restoring: boolean;
  /** `before`: the state before an AI request; `this`: this saved state. */
  onRestore: (entry: VersionEntry, mode: "this" | "before") => void;
  onCompare: (entry: VersionEntry) => void;
  onReload: () => void;
}) {
  const entries = useMemo(() => versionEntries(versions), [versions]);
  const [selected, setSelected] = useState<string | null>(null);
  if (loading && !versions.length)
    return (
      <p className="connect-status" role="status">
        <Spinner /> 버전 기록을 불러오고 있어요.
      </p>
    );
  if (error)
    return (
      <Banner
        tone="danger"
        role="alert"
        action={
          <Button size="sm" onClick={onReload}>
            다시 불러오기
          </Button>
        }
      >
        버전 기록을 불러오지 못했어요.
      </Banner>
    );
  if (!entries.length)
    return (
      <EmptyState icon="clock" title="아직 저장된 버전이 없어요">
        저장할 때마다 여기에 버전이 쌓여요.
      </EmptyState>
    );
  let lastDay = "";
  return (
    <>
      <ol className="vl" aria-label="버전 기록">
        {entries.map((entry) => {
          const day = dayLabel(entry.at);
          const showDay = day !== lastDay;
          lastDay = day;
          const isSelected = selected === entry.key;
          return (
            <li key={entry.key} className="vl-group">
              {showDay ? <p className="vl-day">{day}</p> : null}
              <div
                className={`vl-item is-${entry.kind === "ai" ? "ai" : entry.kind === "original" ? "original" : "manual"} ${entry.current ? "is-current" : ""} ${isSelected ? "is-selected" : ""}`}
              >
                <i aria-hidden="true" />
                <button
                  type="button"
                  aria-expanded={isSelected}
                  onClick={() => setSelected(isSelected ? null : entry.key)}
                >
                  <strong>
                    {entry.title}
                    {entry.current ? (
                      <>
                        {" "}
                        <Badge tone="inverse">지금 파일</Badge>
                      </>
                    ) : null}
                  </strong>
                  <small>{entry.detail}</small>
                </button>
                {isSelected ? (
                  <div className="vl-detail">
                    {entry.previews.some(Boolean) ? (
                      <div className="vl-previews">
                        {entry.previews.slice(0, 2).map((url, index) => (
                          <SlideImage
                            key={index}
                            src={url}
                            alt={`${index + 1}번 슬라이드 미리보기`}
                          />
                        ))}
                      </div>
                    ) : null}
                    <div className="vl-actions">
                      {entry.parentVersionId ? (
                        <Button
                          size="sm"
                          icon="compare"
                          onClick={() => onCompare(entry)}
                        >
                          이전 버전과 비교
                        </Button>
                      ) : null}
                      {entry.kind === "ai" && entry.parentVersionId ? (
                        <Button
                          size="sm"
                          icon="restore"
                          disabled={restoring}
                          onClick={() => onRestore(entry, "before")}
                        >
                          이 요청 전으로 돌아가기
                        </Button>
                      ) : !entry.current ? (
                        <Button
                          size="sm"
                          icon="restore"
                          disabled={restoring}
                          onClick={() => onRestore(entry, "this")}
                        >
                          이 상태로 돌아가기
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
      <p className="ws-panel-note">
        <Icon name="info" size={14} />
        돌아가도 지금 파일은 지워지지 않고 이 목록에 남아요.
      </p>
    </>
  );
}
