"use client";

import type { ReactNode } from "react";
import { Brand, Chip, Menu, MenuItem, MenuSeparator } from "@/design-system";
import type { useAiAccount } from "@/lib/use-ai-account";

type Ai = ReturnType<typeof useAiAccount>;

/** One line of AI status for the app bar. Details live in settings. */
export function AiStatusChip({ ai }: { ai: Ai }) {
  if (ai.status === "loading") return null;
  if (ai.status === "error")
    return (
      <Chip dot="warn" href="/settings">
        AI 연결 확인 필요
      </Chip>
    );
  if (ai.connectionName)
    return (
      <Chip dot="ok" href="/settings">
        AI 연결됨 · {ai.connectionName}
      </Chip>
    );
  return (
    <Chip dot="warn" href="/settings">
      AI 연결 필요
    </Chip>
  );
}

function AccountMenu({ email }: { email: string }) {
  const initial = email.trim().charAt(0).toUpperCase() || "나";
  return (
    <Menu
      label="계정"
      title={email}
      placement="below-end"
      width={220}
      trigger={({ open, toggle, ref, menuId }) => (
        <button
          ref={ref}
          type="button"
          className="app-avatar"
          aria-label="계정 메뉴"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={toggle}
        >
          {initial}
        </button>
      )}
    >
      {(close) => (
        <>
          <MenuItem
            icon="settings"
            title="설정"
            onSelect={() => {
              close();
              window.location.assign("/settings");
            }}
          />
          <MenuSeparator />
          <MenuItem
            icon="logout"
            title="로그아웃"
            onSelect={() => {
              close();
              window.location.assign("/auth/logout");
            }}
          />
        </>
      )}
    </Menu>
  );
}

/** App bar for the file home and settings. `children` sits after the brand. */
export function AppTop({
  email,
  ai,
  children,
}: {
  email: string;
  ai: Ai;
  children?: ReactNode;
}) {
  return (
    <header className="app-top">
      <a href="/" aria-label="파일 목록">
        <Brand />
      </a>
      {children}
      <div className="app-top-actions">
        <AiStatusChip ai={ai} />
        <AccountMenu email={email} />
      </div>
    </header>
  );
}
