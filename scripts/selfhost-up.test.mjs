import assert from "node:assert/strict";
import test from "node:test";

import { selfhostUpPlan, runSelfhostUp } from "./selfhost-up.mjs";

test("builds, starts to health and retires only managed images", () => {
  const plan = selfhostUpPlan("node-test");
  assert.deepEqual(plan.beforeBuild[1].slice(-1), ["--execute"]);
  assert.deepEqual(plan.build, ["docker", ["compose", "build"]]);
  assert.deepEqual(plan.start, [
    "docker",
    ["compose", "up", "--detach", "--no-build", "--wait", "--remove-orphans"],
  ]);
  assert.deepEqual(plan.afterStart[1].slice(-1), ["--execute"]);
});

test("cleans after both build failure and startup failure", () => {
  const plan = selfhostUpPlan("node-test");
  for (const failure of [plan.build, plan.start]) {
    const calls = [];
    assert.throws(
      () =>
        runSelfhostUp(plan, (step) => {
          calls.push(step);
          if (step === failure) throw new Error("injected failure");
        }),
      /injected failure/u,
    );
    assert.equal(calls.at(-1), plan.afterStart);
    assert.equal(calls.filter((step) => step === plan.afterStart).length, 1);
    if (failure === plan.build) assert.ok(!calls.includes(plan.start));
  }
});
