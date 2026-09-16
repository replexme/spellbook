import assert from "node:assert/strict";
import test from "node:test";

import {
  persistedSectionsMatch,
  persistedSlideTopologyMatches,
} from "./harness/product-persistence.mjs";

const opening = {
  id: "{11111111-1111-4111-8111-111111111111}",
  name: "Opening",
  startSlideIndex: 0,
};
const details = {
  id: "{22222222-2222-4222-8222-222222222222}",
  name: "Details",
  startSlideIndex: 1,
};

test("a package-only section edit must persist exact identity and order", () => {
  assert.equal(persistedSectionsMatch([], [], 2), true);
  assert.equal(
    persistedSectionsMatch(
      [opening, details],
      [
        { ...opening, slideCount: 1 },
        { ...details, slideCount: 1 },
      ],
      2,
    ),
    true,
  );
  assert.equal(
    persistedSectionsMatch([opening, details], [details, opening], 2),
    false,
  );
  assert.equal(
    persistedSectionsMatch(
      [opening, details],
      [opening, { ...details, name: "Changed" }],
      2,
    ),
    false,
  );
  assert.equal(persistedSectionsMatch([opening], [], 2), false);
  assert.equal(
    persistedSectionsMatch(
      [opening, details],
      [
        { ...opening, slideCount: 1 },
        { ...details, slideCount: 0 },
      ],
      2,
    ),
    false,
  );
});

test("slide topology checks identity and order, not just the slide count", () => {
  const before = ["256", "257", "258"];
  assert.equal(
    persistedSlideTopologyMatches(
      { op: "move_slide", slideIndex: 0, insertIndex: 2 },
      before,
      ["257", "258", "256"],
    ),
    true,
  );
  assert.equal(
    persistedSlideTopologyMatches(
      { op: "move_slide", slideIndex: 0, insertIndex: 2 },
      before,
      before,
    ),
    false,
  );
  assert.equal(
    persistedSlideTopologyMatches(
      { op: "delete_slide", slideIndex: 1 },
      before,
      ["256", "258"],
    ),
    true,
  );
  assert.equal(
    persistedSlideTopologyMatches(
      { op: "delete_slide", slideIndex: 1 },
      before,
      ["257", "258"],
    ),
    false,
  );
  assert.equal(
    persistedSlideTopologyMatches(
      { op: "duplicate_slide", slideIndex: 0, insertIndex: 1 },
      before,
      ["256", "259", "257", "258"],
    ),
    true,
  );
  assert.equal(
    persistedSlideTopologyMatches({ op: "add_slide", insertIndex: 1 }, before, [
      "256",
      "257",
      "257",
      "258",
    ]),
    false,
  );
});
