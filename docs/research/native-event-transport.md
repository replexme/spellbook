# Native editor event transport: measurement and decision

Measured 2026-09-23 with the same `pollNativeSession` database read behind three transports. This is a **local PostgreSQL 16 / Docker measurement**, not production latency or a billing invoice. Six committed events were written about 950 ms apart; the three listeners ran concurrently, with one DB pool connection and separate native sessions. The benchmark is opt-in in `apps/web/src/lib/native-runtime.integration.test.ts` (`SPELLBOOK_NATIVE_BENCH=1`, `SPELLBOOK_DB_POOL_MAX=1`, `SPELLBOOK_NATIVE_INTEGRATION=1`, `DATABASE_URL` set to a disposable local PostgreSQL database). Run its `compares committed-event latency` test with `--reporter=verbose --silent=false` to print `NATIVE_TRANSPORT_BENCH`; repeat under production-like concurrency before changing the policy.

| Transport | Delivered | Snapshot reads in ~7.7 s | Local p50 | Local p95 |
| --- | ---: | ---: | ---: | ---: |
| PostgreSQL NOTIFY → SSE | 6/6 | 7 | 15 ms | 20 ms |
| HTTP polling, active 250 ms | 6/6 | 29 | 108 ms | 205 ms |
| HTTP polling, idle 1,500 ms | 6/6 | 5 | 574 ms | 1,274 ms |

An additional headless HTTP check used the assembled managed Next.js Docker image, disposable PostgreSQL 16, a document-scoped bearer token and an inserted event. The response contained an initial empty snapshot followed by a snapshot containing the committed event over the same HTTP stream. This establishes Next.js response flushing locally, not Cloud Run proxy behavior.

A snapshot read is **not** one SQL query: `pollNativeSession` executes multiple queries and maintenance work. It is a comparable workload proxy, not a measured CPU or billable-cost figure. Burst traffic is coalesced to at most one SSE snapshot every 250 ms; missed notifications are recovered by the durable event cursor and an 8 s maintenance snapshot. Each stream ends after 55 s and resumes with the last processed cursor. Authorization remains in the `fetch` request header, never a URL query string. LISTEN uses one connection per web instance while there are subscribers, not one per browser.

**Decision: hybrid.** Stream while an AI turn is busy, then close the stream and poll at 250 ms for pending saves or 1,500 ms when idle. The lower event latency and reduced active snapshot reads justify an active stream. An always-open SSE connection is not justified on the current request-billed Cloud Run web service: the entire open response counts as an in-flight request, potentially keeping a 1-vCPU/512-MiB instance billable and preventing scale-to-zero. Overlapping streams can share an instance; monthly cost cannot be inferred without concurrency, session duration, free-tier allocation, and actual billing exports. `NEXT_PUBLIC_NATIVE_EVENTS_MODE=poll` selects polling at build time; the current managed Docker build does not expose that argument, so its operational rollback is the previous image until the Replex deployment contract adds the build switch.

Before production promotion, verify the assembled managed web image, database trigger migration, browser turn/reconnect behavior, Cloud Run request duration and database connection counts, and billing after rollout. Do not describe this as zero-latency push or an exact monthly saving.

References: [Cloud Run request-based billing](https://cloud.google.com/run/pricing), [request timeout](https://cloud.google.com/run/docs/configuring/request-timeout), [PostgreSQL LISTEN](https://www.postgresql.org/docs/current/sql-listen.html), [PostgreSQL NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html), [MDN SSE](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events).
