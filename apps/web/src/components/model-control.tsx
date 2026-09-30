"use client";

import { useEffect, useState } from "react";
import type { AvailableModel, ModelSettings } from "@/lib/ai-models";
import { SpellbookIcon } from "./spellbook-ui";

export function ModelControl({
  value,
  disabled,
  onChange,
  loadModels,
}: {
  value: ModelSettings | undefined;
  disabled: boolean;
  onChange: (value: ModelSettings | undefined) => void;
  loadModels?: (signal: AbortSignal) => Promise<{ models: AvailableModel[] }>;
}) {
  const [models, setModels] = useState<AvailableModel[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setStatus("loading");
    void (
      loadModels
        ? loadModels(abort.signal)
        : fetch("/api/ai/models", {
            cache: "no-store",
            signal: abort.signal,
          }).then(async (response) => {
            if (!response.ok) throw new Error("models_unavailable");
            return (await response.json()) as { models: AvailableModel[] };
          })
    )
      .then((body) => {
        if (!body.models?.length) throw new Error("models_empty");
        setModels(body.models);
        if (!value) {
          const initial =
            body.models.find((item) => item.isDefault) ?? body.models[0];
          onChange({
            ...(initial.provider ? { provider: initial.provider } : {}),
            model: initial.model,
            effort: initial.defaultReasoningEffort,
          });
        }
        setStatus("ready");
      })
      .catch(() => {
        if (!abort.signal.aborted) setStatus("error");
      });
    return () => abort.abort();
  }, [generation, loadModels]);
  const model = models.find(
    (item) =>
      item.model === value?.model &&
      (!value?.provider || item.provider === value.provider),
  );
  const recommended = models.find((item) => item.isDefault) ?? models[0];
  return (
    <details className="model-control">
      <summary title="모델과 추론 강도">
        <span>
          {value
            ? `${model?.provider === "claude_code" ? "Claude Code · " : "Codex · "}${model?.displayName ?? value.model} · ${value.effort}`
            : "모델 선택"}
        </span>
        <SpellbookIcon name="chevronDown" size={13} />
      </summary>
      <div className="model-popover">
        <header>
          <span>
            <SpellbookIcon name="sparkles" size={15} />
          </span>
          <div>
            <strong>AI 실행 설정</strong>
            <p>다음 요청에 사용할 모델과 추론 강도</p>
          </div>
        </header>
        {status === "loading" ? (
          <p role="status">구독 계정의 모델 확인 중…</p>
        ) : null}
        {status === "error" ? (
          <p role="alert">
            모델 목록을 불러오지 못했습니다. <a href="/">계정 연결 확인</a>
          </p>
        ) : null}
        {status === "ready" ? (
          <>
            <label>
              모델
              <select
                aria-label="실행 모델"
                disabled={disabled}
                value={value?.model ?? ""}
                onChange={(event) => {
                  const next = models.find(
                    (item) => item.model === event.target.value,
                  );
                  onChange(
                    next
                      ? {
                          ...(next.provider ? { provider: next.provider } : {}),
                          model: next.model,
                          effort: next.defaultReasoningEffort,
                        }
                      : undefined,
                  );
                }}
              >
                <option value="">
                  서버 기본 설정
                  {recommended ? ` (추천: ${recommended.displayName})` : ""}
                </option>
                {value && !model ? (
                  <option value={value.model}>
                    {value.model} · 현재 사용할 수 없음
                  </option>
                ) : null}
                {models.map((item) => (
                  <option key={item.model} value={item.model}>
                    {item.provider === "claude_code"
                      ? "Claude Code · "
                      : "Codex · "}
                    {item.displayName}
                    {item.isDefault ? " · 추천" : ""}
                    {item.imageGeneration === true ? " · 이미지 생성 가능" : ""}
                  </option>
                ))}
              </select>
            </label>
            {model ? (
              <label>
                추론 강도
                <select
                  aria-label="추론 강도"
                  disabled={disabled}
                  value={value?.effort}
                  onChange={(event) =>
                    onChange({
                      ...(model.provider ? { provider: model.provider } : {}),
                      model: model.model,
                      effort: event.target.value,
                    })
                  }
                >
                  {model.supportedReasoningEfforts.map((item) => (
                    <option
                      key={item.reasoningEffort}
                      value={item.reasoningEffort}
                    >
                      {item.reasoningEffort}
                      {item.reasoningEffort === model.defaultReasoningEffort
                        ? " · 기본"
                        : ""}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <p>
              {disabled
                ? "현재 실행 중인 모델은 유지됩니다. 작업이 끝나면 변경할 수 있습니다."
                : "선택은 다음 요청부터 적용됩니다. 높은 추론 강도는 응답 시간과 구독 사용량을 늘릴 수 있습니다."}
            </p>
            {model ? (
              <small>
                {
                  model.supportedReasoningEfforts.find(
                    (item) => item.reasoningEffort === value?.effort,
                  )?.description
                }
                {` · ${model.imageGeneration === true ? "이미지 생성 가능" : "이미지 생성 미지원"}`}
              </small>
            ) : null}
          </>
        ) : null}
        <button
          className="ds-button is-secondary is-compact"
          type="button"
          disabled={status === "loading"}
          onClick={() => setGeneration((value) => value + 1)}
        >
          모델 목록 새로고침
        </button>
      </div>
    </details>
  );
}
