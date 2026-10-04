import { describe, expect, it } from "vitest";

import {
  documentJobRecovery,
  documentJobRecoveryPolicy,
  jobRedeliverySeconds,
  NATIVE_AGENT_LEASE_SECONDS,
} from "./job-delivery";

describe("durable local job delivery", () => {
  it("uses a bounded redelivery lease", () => {
    expect(jobRedeliverySeconds(undefined)).toBe(15);
    expect(jobRedeliverySeconds("5")).toBe(5);
    expect(jobRedeliverySeconds("900")).toBe(900);
    expect(() => jobRedeliverySeconds("4")).toThrow();
    expect(() => jobRedeliverySeconds("901")).toThrow();
    expect(() => jobRedeliverySeconds("1.5")).toThrow();
    expect(() => jobRedeliverySeconds("not-a-number")).toThrow();
  });

  it("gives a native agent enough time to miss multiple heartbeats before takeover", () => {
    expect(NATIVE_AGENT_LEASE_SECONDS).toBe(60);
  });
});

describe("stale document job recovery", () => {
  const policy = documentJobRecoveryPolicy({});
  const now = new Date("2026-10-04T12:00:00Z");
  const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);
  const job = (
    overrides: Partial<Parameters<typeof documentJobRecovery>[0]>,
  ) => ({
    createdAt: ago(60),
    updatedAt: ago(60),
    dispatchedAt: ago(60),
    deliveryCount: 1,
    ...overrides,
  });

  it("never sends a delivered job again while its worker may still run it", () => {
    expect(policy.attemptSeconds).toBeGreaterThan(900);
    expect(documentJobRecovery(job({}), now, policy)).toBe("wait");
    expect(
      documentJobRecovery(job({ dispatchedAt: ago(899) }), now, policy),
    ).toBe("wait");
  });

  it("retries a job that never reached its queue after the short cooldown", () => {
    expect(
      documentJobRecovery(
        job({ dispatchedAt: null, deliveryCount: 0, updatedAt: ago(5) }),
        now,
        policy,
      ),
    ).toBe("wait");
    expect(
      documentJobRecovery(
        job({ dispatchedAt: null, deliveryCount: 0, updatedAt: ago(16) }),
        now,
        policy,
      ),
    ).toBe("redeliver");
  });

  it("redelivers a lost delivery once its attempt budget has passed", () => {
    expect(
      documentJobRecovery(
        job({ createdAt: ago(1000), dispatchedAt: ago(970) }),
        now,
        policy,
      ),
    ).toBe("redeliver");
  });

  it("fails visibly after too many deliveries or too long", () => {
    expect(
      documentJobRecovery(
        job({ createdAt: ago(1000), dispatchedAt: ago(970), deliveryCount: 3 }),
        now,
        policy,
      ),
    ).toBe("fail");
    expect(
      documentJobRecovery(
        job({ createdAt: ago(policy.maxAgeSeconds), dispatchedAt: ago(10) }),
        now,
        policy,
      ),
    ).toBe("fail");
    expect(
      documentJobRecovery(
        job({
          createdAt: ago(policy.maxAgeSeconds + 1),
          dispatchedAt: null,
          updatedAt: ago(1),
        }),
        now,
        policy,
      ),
    ).toBe("fail");
  });
});
