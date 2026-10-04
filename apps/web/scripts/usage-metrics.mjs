#!/usr/bin/env node
// Prints Spellbook usage numbers for a period: activation, edit success,
// AI success by provider and D1/D7 return visits.
//
//   DATABASE_URL=postgres://... node scripts/usage-metrics.mjs 2026-10-04 2026-10-31
//
// The query is scripts/usage-metrics.sql; it reads only usage events, which
// hold account ids, document ids, action kinds and reason codes.
import { readFileSync } from "node:fs";
import postgres from "postgres";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const seoulToday = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
}).format(new Date());
const [from, to = seoulToday] = process.argv
  .slice(2)
  .filter((value) => !value.startsWith("--"));
if (!from || !DATE.test(from) || !DATE.test(to)) {
  console.error(
    "usage: node scripts/usage-metrics.mjs <from YYYY-MM-DD> [to YYYY-MM-DD]",
  );
  process.exit(2);
}

const url = process.env.DATABASE_URL?.trim();
const sql = url
  ? postgres(url, { max: 1, prepare: false })
  : postgres({
      host: process.env.SPELLBOOK_DB_HOST,
      port: Number(process.env.SPELLBOOK_DB_PORT ?? 5432),
      database: process.env.SPELLBOOK_DB_NAME,
      username: process.env.SPELLBOOK_DB_USER,
      password: process.env.SPELLBOOK_DB_PASSWORD,
      max: 1,
      prepare: false,
    });

const ratio = (part, whole) =>
  whole
    ? `${part} / ${whole} (${((part / whole) * 100).toFixed(1)}%)`
    : `${part} / 0`;

try {
  const text = readFileSync(
    new URL("./usage-metrics.sql", import.meta.url),
    "utf8",
  );
  const [row] = await sql.unsafe(text, [
    from,
    to,
    seoulToday < to ? seoulToday : to,
  ]);
  const m = row.metrics;
  const lines = [
    `기간 ${from} ~ ${to}`,
    `새 계정 ${m.activation.newAccounts}`,
    `활성화(7일 안에 편집 저장) ${ratio(m.activation.editedWithin7Days, m.activation.newAccounts)}`,
    `7일 안에 내려받기 ${ratio(m.activation.downloadedWithin7Days, m.activation.newAccounts)}`,
    `편집 성공률(계정·문서·날짜 묶음) ${ratio(m.edits.successfulGroups, m.edits.editGroups)}`,
    `저장 거절 ${m.edits.savesRejected} · 브라우저 저장 실패 신고 ${m.edits.clientReportedFailures}`,
    ...m.ai.map(
      (item) =>
        `AI 성공률 ${item.provider} ${ratio(item.completed, item.completed + item.failed)} · 취소 ${item.cancelled}`,
    ),
    `D1 재방문 ${ratio(m.retention.d1Returned, m.retention.d1Eligible)}`,
    `D7 재방문 ${ratio(m.retention.d7Returned, m.retention.d7Eligible)}`,
    `1주 안 재방문 ${ratio(m.retention.week1Returned, m.retention.d7Eligible)}`,
  ];
  console.log(lines.join("\n"));
  if (process.argv.includes("--json")) console.log(JSON.stringify(m, null, 2));
} finally {
  await sql.end({ timeout: 1 });
}
