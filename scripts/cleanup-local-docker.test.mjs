import assert from "node:assert/strict";
import test from "node:test";

import {
  componentFromImage,
  planSpellbookImageCleanup,
} from "./cleanup-local-docker.mjs";

const image = (id, component, createdAt) => ({
  id,
  component,
  createdAt,
  references: [`spellbook-${component}:${id}`],
});

test("keeps every container image and one rollback per Spellbook component", () => {
  const images = [
    image("web-current", "web", "2026-09-15T03:00:00Z"),
    image("web-rollback", "web", "2026-09-15T02:00:00Z"),
    image("web-old", "web", "2026-09-15T01:00:00Z"),
    image("worker-current", "document-worker", "2026-09-15T03:00:00Z"),
    image("worker-old", "document-worker", "2026-09-15T01:00:00Z"),
    { id: "unmanaged", component: null, createdAt: "2026-09-15T00:00:00Z" },
  ];
  const plan = planSpellbookImageCleanup(
    images,
    ["web-current", "worker-current"],
    { keepUnusedPerComponent: 1 },
  );
  assert.deepEqual(
    plan.remove.map(({ id }) => id),
    ["web-old"],
  );
  assert.deepEqual(
    plan.keep.map(({ id, reason }) => [id, reason]),
    [
      ["web-current", "container"],
      ["web-rollback", "rollback"],
      ["worker-current", "container"],
      ["worker-old", "rollback"],
    ],
  );
});

test("can remove all unused labeled images without touching active ones", () => {
  const plan = planSpellbookImageCleanup(
    [
      image("active", "office-editor", "2026-09-15T02:00:00Z"),
      image("unused", "office-editor", "2026-09-15T03:00:00Z"),
    ],
    ["active"],
    { keepUnusedPerComponent: 0 },
  );
  assert.deepEqual(
    plan.keep.map(({ id }) => id),
    ["active"],
  );
  assert.deepEqual(
    plan.remove.map(({ id }) => id),
    ["unused"],
  );
});

test("defaults to removing every unused managed image immediately", () => {
  const plan = planSpellbookImageCleanup([
    image("newest-unused", "web", "2026-10-03T01:00:00Z"),
    image("active", "web", "2026-10-02T01:00:00Z"),
  ], ["active"]);
  assert.deepEqual(plan.remove.map(({ id }) => id), ["newest-unused"]);
  assert.deepEqual(plan.keep.map(({ id }) => id), ["active"]);
});

test("adopts only exact legacy Spellbook Compose image names", () => {
  assert.equal(
    componentFromImage({
      component: null,
      references: ["spellbook-office-editor:security-local"],
    }),
    "office-editor",
  );
  assert.equal(
    componentFromImage({
      component: null,
      references: ["spellbook-browser-office:browser-v1"],
    }),
    "browser-office",
  );
  assert.equal(
    componentFromImage({
      component: null,
      references: ["another-spellbook-web:latest"],
    }),
    null,
  );
});
