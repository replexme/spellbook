import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import {
  buildChangeBudget,
  buildScenarioExecutionPlan,
  CONTAINER_REACHABLE_PROBE_BIND_ADDRESS,
  dotnetHostCommand,
  isTransientEditorConnectionFailure,
  localProbeBrowserOrigin,
  operationsFromReport,
  persistenceStateFromProbeOutput,
  withNoopSaveBaseline,
  waitForSavedFile,
} from "./native-mutation-conformance-runner.mjs";
import { buildConformancePlan } from "./native-mutation-conformance.mjs";

const capabilities = JSON.parse(
  fs.readFileSync("contracts/native-edit-capabilities.json", "utf8"),
);
const conformance = JSON.parse(
  fs.readFileSync("contracts/native-mutation-conformance.json", "utf8"),
);
const publicSources = JSON.parse(
  fs.readFileSync("eval/public/sources.json", "utf8"),
);

function assertPinnedPublicSource(scenario) {
  if (fs.existsSync(scenario.source)) {
    assert.equal(
      createHash("sha256")
        .update(fs.readFileSync(scenario.source))
        .digest("hex"),
      scenario.sourceSha256,
    );
    return;
  }
  const match = /^eval\/public\/downloads\/([^/]+)\.pptx$/u.exec(
    scenario.source,
  );
  assert.ok(match, `${scenario.source} is neither checked in nor fetchable`);
  const deck = publicSources.decks.find(({ id }) => id === match[1]);
  assert.ok(deck, `${scenario.source} is missing from the public catalog`);
  assert.equal(deck.sha256, scenario.sourceSha256);
}

test("execution plan assigns a real PPTX and bounded operation routes to every scenario", () => {
  const plan = buildConformancePlan(capabilities, conformance);
  const scenarios = buildScenarioExecutionPlan(capabilities, conformance, plan);

  assert.equal(scenarios.length, 13);
  assert.equal(scenarios[0].name, "table-structure");
  assert.equal(scenarios.at(-1).name, "general-native-surface");
  scenarios.forEach(assertPinnedPublicSource);
  assert.ok(
    scenarios.every((scenario) => /^[0-9a-f]{64}$/.test(scenario.sourceSha256)),
  );
  assert.ok(
    scenarios.every(
      (scenario) =>
        scenario.expectedPatchLevel === `undo-v${conformance.enginePatchLevel}`,
    ),
  );
  assert.ok(scenarios.every((scenario) => scenario.allowedOperations.length));
  assert.deepEqual(
    scenarios.find((scenario) => scenario.name === "animation-timing")
      .allowedOperations,
    [
      "add_animation_effect",
      "move_animation_effect",
      "remove_animation_effect",
      "replace_animation_effect",
      "set_animation_timing",
    ],
  );
  assert.deepEqual(
    scenarios.find((scenario) => scenario.name === "object-interaction")
      .allowedOperations,
    ["set_object_interaction"],
  );
  assert.deepEqual(
    scenarios.find((scenario) => scenario.name === "semantic-assets")
      .allowedOperations,
    [
      "insert_image",
      "insert_media",
      "replace_image",
      "replace_media",
      "set_media_playback",
    ],
  );
});

test("partial family runs retain selected coverage without pretending a shared scenario is isolated", () => {
  const plan = buildConformancePlan(capabilities, conformance, {
    families: ["object_text"],
  });
  const [scenario] = buildScenarioExecutionPlan(
    capabilities,
    conformance,
    plan,
  );

  assert.equal(scenario.name, "general-native-surface");
  assert.ok(scenario.selectedOperations.includes("replace_text_range"));
  assert.ok(scenario.allowedOperations.includes("insert_slide"));
  assert.ok(!scenario.selectedOperations.includes("insert_slide"));
});

test("the runner supplies the contract-derived operation set to each probe", () => {
  const plan = buildConformancePlan(capabilities, conformance);
  const scenarios = buildScenarioExecutionPlan(capabilities, conformance, plan);
  const general = scenarios.find(
    (scenario) => scenario.name === "general-native-surface",
  );

  assert.ok(general.allowedOperations.includes("insert_slide"));
  assert.ok(general.allowedOperations.includes("set_slide_layout"));
  assert.ok(general.allowedOperations.includes("text_shadow"));
  assert.ok(general.allowedOperations.includes("set_slide_metadata"));
  assert.ok(general.allowedOperations.includes("set_line_style"));
  assert.ok(general.allowedOperations.includes("set_paragraph_format"));
});

test("report operation extraction is stable for broad and dedicated probes", () => {
  assert.deepEqual(
    operationsFromReport({
      commands: ["move", { op: "resize" }, "move"],
      operation: "replace_text",
    }),
    ["move", "replace_text", "resize"],
  );
});

test("change budgets are derived from executed operation families and identity effects", () => {
  const budget = buildChangeBudget(
    capabilities,
    ["insert_slide", "set_speaker_notes"],
    null,
  );

  assert.equal(budget.allowPartCreationOrDeletion, true);
  assert.ok(budget.allowedCategories.includes("document_properties"));
  assert.ok(budget.allowedCategories.includes("presentation"));
  assert.ok(budget.allowedCategories.includes("notes_parts"));
  assert.ok(!budget.allowedCategories.includes("unknown"));
  assert.ok(budget.allowedCategories.includes("notes_master_parts"));
  assert.ok(budget.allowedCategories.includes("theme_parts"));
  assert.ok(
    capabilities.mutationModel.families.slide_properties.changeBudget.includes(
      "slide_relationships",
    ),
  );
  const size = buildChangeBudget(capabilities, ["set_slide_size"], null);
  assert.deepEqual(size.allowedCategories, ["presentation", "slide_parts"]);
  assert.equal(size.allowPartCreationOrDeletion, false);
  const theme = buildChangeBudget(capabilities, ["set_master_theme"], null);
  assert.equal(theme.allowPartCreationOrDeletion, true);
  assert.ok(theme.allowedCategories.includes("slide_layout_relationships"));
  assert.ok(theme.allowedCategories.includes("slide_master_relationships"));
});

test("a notes-only mutation may create the package infrastructure required by OOXML", () => {
  const budget = buildChangeBudget(capabilities, ["set_speaker_notes"], [0]);

  assert.equal(budget.allowPartCreationOrDeletion, true);
  assert.deepEqual(budget.targetSlideIndexes, [0]);
  assert.ok(budget.allowedCategories.includes("package_manifest"));
  assert.ok(budget.allowedCategories.includes("presentation_relationships"));
  assert.ok(budget.allowedCategories.includes("notes_master_parts"));
  assert.ok(budget.allowedCategories.includes("notes_master_relationships"));
  assert.ok(budget.allowedCategories.includes("theme_parts"));
});

test("the public document tool implements the change-budget contract used by the runner", () => {
  const tool = fs.readFileSync(
    "services/document-worker/tools/Spellbook.Document.Tool/Program.cs",
    "utf8",
  );
  const validator = fs.readFileSync(
    "services/document-worker/src/Spellbook.Document.Core/PptxPackageChangeBudgetValidator.cs",
    "utf8",
  );
  assert.match(tool, /case "validate-change-budget"/u);
  const categoryBlock =
    /Categories \{ get; \} = new HashSet<string>\(StringComparer\.Ordinal\)\s*\{(?<body>[\s\S]*?)\n\s*\};/u.exec(
      validator,
    );
  const implemented = [
    ...(categoryBlock?.groups?.body ?? "").matchAll(/"([a-z_]+)"/gu),
  ]
    .map(([, category]) => category)
    .sort();
  assert.deepEqual(
    implemented,
    [...capabilities.mutationModel.changeBudgetContract.categories].sort(),
  );
});

test("browser origin matches the WOPI PostMessageOrigin contract", () => {
  assert.equal(localProbeBrowserOrigin(31_907), "http://localhost:31907");
  assert.throws(() => localProbeBrowserOrigin(0), /port is invalid/);
});

test("the native runner exposes its ephemeral probe to the Linux editor container", () => {
  assert.equal(CONTAINER_REACHABLE_PROBE_BIND_ADDRESS, "0.0.0.0");
});

test("the runner honors the SDK host path used by clean-machine installs", () => {
  assert.equal(dotnetHostCommand({}), "dotnet");
  assert.equal(
    dotnetHostCommand({ DOTNET_HOST_PATH: "/opt/dotnet/dotnet" }),
    "/opt/dotnet/dotnet",
  );
});

test("baseline probe output keeps only comparable persistence state", () => {
  assert.deepEqual(
    persistenceStateFromProbeOutput(
      JSON.stringify({
        revision: "ignored",
        slides: [{ slideIndex: 0 }],
        masters: [{ masterIndex: 0 }],
        images: [{ byteLength: 123 }],
      }),
    ),
    {
      slides: [{ slideIndex: 0 }],
      masters: [{ masterIndex: 0 }],
    },
  );
  assert.throws(
    () => persistenceStateFromProbeOutput("{}"),
    /returned no slide\/master state/,
  );
});

test("both native runners attach the observed no-op save and reject a fabricated baseline", () => {
  const output = JSON.stringify({
    slides: [{ slideIndex: 0 }],
    masters: [{ masterIndex: 0 }],
  });
  const report = { commands: ["set_paragraph_format"] };
  assert.deepEqual(withNoopSaveBaseline(report, output), {
    ...report,
    persistenceBaseline: {
      slides: [{ slideIndex: 0 }],
      masters: [{ masterIndex: 0 }],
    },
  });
  assert.equal(Object.hasOwn(report, "persistenceBaseline"), false);
  assert.throws(
    () => withNoopSaveBaseline({ persistenceBaseline: {} }, output),
    /cannot supply its own no-op baseline/,
  );
  assert.throws(
    () => withNoopSaveBaseline(report, "{}"),
    /returned no slide\/master state/,
  );
});

test("only extension connection timeouts qualify for read-only session retry", () => {
  assert.equal(
    isTransientEditorConnectionFailure(
      new Error("Native editor extension did not connect."),
    ),
    true,
  );
  assert.equal(
    isTransientEditorConnectionFailure(new Error("PPTX persistence failed")),
    false,
  );
});

test("the runner reopens the latest save after the WOPI version settles", async () => {
  let receiptReads = 0;

  const saved = await waitForSavedFile(
    {
      receipt: () => ({
        version: receiptReads++ < 2 ? 1 : 2,
      }),
    },
    "/tmp/conformance-session",
    { timeoutMs: 200, settleMs: 25, pollMs: 5 },
  );

  assert.equal(saved, "/tmp/conformance-session/saved-2.pptx");
});
