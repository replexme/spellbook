"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Chip,
  Icon,
  IconButton,
  Menu,
  MenuItem,
  Segmented,
  Spinner,
} from "@/design-system";
import type { AvailableModel, ModelSettings } from "@/lib/ai-models";
import {
  effortDescription,
  effortTitle,
  scopeOptions,
  scopeTitle,
  type PermissionMode,
} from "../copy";
import { scopeDescription, scopeLabel, type EditorSelection } from "./request-scope";

function providerName(provider: AvailableModel["provider"]) {
  return provider === "claude_code" ? "Claude Code" : "Codex";
}

/** Model and thinking depth. Closes on choice, outside click and Escape. */
export function ModelMenu({
  value,
  onChange,
  disabled,
  loadModels,
}: {
  value: ModelSettings | undefined;
  onChange: (value: ModelSettings | undefined) => void;
  disabled: boolean;
  loadModels: (signal: AbortSignal) => Promise<{ models: AvailableModel[] }>;
}) {
  const [models, setModels] = useState<AvailableModel[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setStatus("loading");
    loadModels(abort.signal)
      .then((body) => {
        if (!body.models?.length) throw new Error("models_empty");
        setModels(body.models);
        if (!value) {
          const initial = body.models.find((item) => item.isDefault) ?? body.models[0]!;
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
    // Reload only when asked; value changes must not refetch the catalogue.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation, loadModels]);
  const model = models.find(
    (item) => item.model === value?.model && (!value?.provider || item.provider === value.provider),
  );
  const efforts = model?.supportedReasoningEfforts ?? [];
  const label = value
    ? `${providerName(model?.provider ?? value.provider)} · ${effortTitle(value.effort)}`
    : status === "error"
      ? "모델을 불러오지 못함"
      : "모델 확인 중";
  return (
    <Menu
      label="AI 모델과 생각 깊이"
      title={model ? `AI 모델 · ${providerName(model.provider)} 구독` : "AI 모델"}
      placement="above-start"
      width={300}
      trigger={({ open, toggle, ref, menuId }) => (
        <button
          ref={ref}
          type="button"
          className="ds-chip composer-model"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          aria-label={`AI 모델: ${label}`}
          disabled={disabled}
          onClick={toggle}
        >
          <span>{label}</span>
          <Icon name="chevronDown" size={13} />
        </button>
      )}
    >
      {(close) =>
        status === "loading" ? (
          <p className="ds-menu-section composer-menu-note">
            <Spinner /> 구독에서 쓸 수 있는 모델을 확인하고 있어요.
          </p>
        ) : status === "error" ? (
          <div className="ds-menu-section composer-menu-note">
            <p>모델 목록을 불러오지 못했어요. AI 연결을 확인한 뒤 다시 시도해 주세요.</p>
            <button type="button" className="ds-button is-sm" onClick={() => setGeneration((n) => n + 1)}>
              다시 불러오기
            </button>
          </div>
        ) : (
          <>
            {models.map((item) => (
              <MenuItem
                key={`${item.provider ?? "codex"}:${item.model}`}
                checked={item === model}
                title={
                  <>
                    {item.displayName}
                    {item.isDefault ? <span className="ds-badge composer-recommended">추천</span> : null}
                  </>
                }
                description={providerName(item.provider)}
                onSelect={() => {
                  onChange({
                    ...(item.provider ? { provider: item.provider } : {}),
                    model: item.model,
                    effort: item.defaultReasoningEffort,
                  });
                  close();
                }}
              />
            ))}
            {model && efforts.length > 1 ? (
              <div className="ds-menu-section composer-effort">
                <p className="ds-menu-title">생각 깊이</p>
                <Segmented
                  label="생각 깊이"
                  value={value?.effort ?? model.defaultReasoningEffort}
                  options={efforts.map((item) => ({
                    value: item.reasoningEffort,
                    label: effortTitle(item.reasoningEffort),
                  }))}
                  onChange={(effort) =>
                    onChange({
                      ...(model.provider ? { provider: model.provider } : {}),
                      model: model.model,
                      effort,
                    })
                  }
                />
                <p className="composer-menu-note">{effortDescription(value?.effort)}</p>
              </div>
            ) : null}
            <p className="ds-menu-section composer-menu-foot">다음 요청부터 적용돼요.</p>
          </>
        )
      }
    </Menu>
  );
}

/** What the AI may change, visible before sending; follows the editor's selection. */
export function ScopeMenu({
  value,
  onChange,
  disabled,
  selection = null,
}: {
  value: PermissionMode;
  onChange: (value: PermissionMode) => void;
  disabled?: boolean;
  selection?: EditorSelection | null;
}) {
  const nothingSelected = value === "selection" && selection !== null && selection.selected.length === 0;
  return (
    <Menu
      label="AI가 바꿀 수 있는 범위"
      title="AI가 바꿀 수 있는 범위"
      placement="above-start"
      width={296}
      trigger={({ open, toggle, ref, menuId }) => (
        <button
          ref={ref}
          type="button"
          className={`ds-chip ${nothingSelected ? "is-warn" : "is-ai"}`}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          aria-label={`AI가 바꿀 수 있는 범위: ${scopeLabel(value, selection)}`}
          disabled={disabled}
          onClick={toggle}
        >
          <Icon name="scope" size={13} />
          <span>{scopeLabel(value, selection)}</span>
          <Icon name="chevronDown" size={13} />
        </button>
      )}
    >
      {(close) =>
        scopeOptions.map((option) => (
          <MenuItem
            key={option.value}
            checked={option.value === value}
            title={option.title}
            description={scopeDescription(option.value, selection)}
            onSelect={() => {
              onChange(option.value);
              close();
            }}
          />
        ))
      }
    </Menu>
  );
}

export function Composer({
  text,
  onText,
  onSubmit,
  onStop,
  busy,
  canSend,
  permission,
  onPermission,
  model,
  onModel,
  loadModels,
  onAttach,
  attaching,
  inputRef,
  placeholder,
  selection = null,
}: {
  text: string;
  onText: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  busy: boolean;
  canSend: boolean;
  permission: PermissionMode;
  onPermission: (value: PermissionMode) => void;
  model: ModelSettings | undefined;
  onModel: (value: ModelSettings | undefined) => void;
  loadModels: (signal: AbortSignal) => Promise<{ models: AvailableModel[] }>;
  onAttach: () => void;
  attaching: boolean;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  placeholder?: string;
  selection?: EditorSelection | null;
}) {
  const local = useRef<HTMLTextAreaElement>(null);
  const textarea = inputRef ?? local;
  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = "0px";
    element.style.height = `${Math.min(180, Math.max(52, element.scrollHeight))}px`;
  }, [text, textarea]);
  return (
    <div className="composer">
      <div className="composer-scope">
        <ScopeMenu value={permission} onChange={onPermission} disabled={busy} selection={selection} />
      </div>
      <textarea
        ref={textarea}
        aria-label="AI에게 요청"
        placeholder={placeholder ?? "무엇을 바꿀까요?"}
        value={text}
        onChange={(event) => onText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            onSubmit();
          }
        }}
      />
      <div className="composer-row">
        <IconButton
          icon="paperclip"
          label="그림 또는 미디어 첨부"
          size="sm"
          disabled={busy || attaching}
          onClick={onAttach}
        />
        <ModelMenu value={model} onChange={onModel} disabled={busy} loadModels={loadModels} />
        {busy ? (
          <IconButton
            className="composer-send"
            icon="stop"
            label="AI 작업 멈추기"
            tone="primary"
            onClick={onStop}
          />
        ) : (
          <IconButton
            className="composer-send"
            icon="arrowUp"
            label="요청 보내기"
            tone="ai"
            disabled={!canSend || !text.trim()}
            onClick={onSubmit}
          />
        )}
      </div>
    </div>
  );
}

export function ScopeChip({ mode }: { mode: string }) {
  return <Chip icon="scope">범위 · {scopeTitle(mode)}</Chip>;
}
