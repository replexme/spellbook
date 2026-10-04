import { Banner, Progress } from "@/design-system";
import {
  AUTOSAVE_VERSIONS_KEPT,
  storageAmount,
  storageFull,
} from "@/lib/storage-quota";
import type { AccountStorage } from "@/lib/storage-usage";

/** How much the account keeps, against its plan's limits. */
export function StorageSection({ storage }: { storage: AccountStorage }) {
  const { usage, limits } = storage;
  const full = storageFull(usage, limits);
  return (
    <section
      id="storage"
      className="settings-section"
      aria-labelledby="settings-storage"
    >
      <header>
        <h1 id="settings-storage">보관 공간</h1>
        <p>
          가져온 원본, 저장한 버전, 슬라이드 그림과 넣은 이미지를 모두 합친
          크기예요. 자동 저장본은 파일마다 최근 {AUTOSAVE_VERSIONS_KEPT}개만
          남기고, 가져온 원본과 AI 결과, 되돌린 버전은 지우지 않아요.
        </p>
      </header>
      {limits ? (
        <>
          <p className="ds-tabular">
            <strong>{storageAmount(usage.bytes)}</strong>
            {limits.bytes !== null
              ? ` / ${storageAmount(limits.bytes)}`
              : ""}{" "}
            사용 · 파일 {usage.documents}개
            {limits.documents !== null ? ` / ${limits.documents}개` : ""}
          </p>
          {limits.bytes !== null ? (
            <Progress
              value={usage.bytes / limits.bytes}
              label="보관 공간 사용량"
            />
          ) : null}
          {full ? (
            <div style={{ marginTop: "1rem" }}>
              <Banner tone="warn" role="status">
                보관 공간이 가득 찼어요. 새 파일 가져오기와 새 저장은 멈췄지만,
                파일 열기·내려받기·삭제는 그대로 돼요. 필요 없는 파일을 내려받은
                뒤 삭제하거나 <a href="#plan">요금제</a>를 바꾸면 다시 쓸 수
                있어요.
              </Banner>
            </div>
          ) : null}
        </>
      ) : (
        <p className="ds-tabular">
          <strong>{storageAmount(usage.bytes)}</strong> 사용 · 파일{" "}
          {usage.documents}개
        </p>
      )}
    </section>
  );
}
