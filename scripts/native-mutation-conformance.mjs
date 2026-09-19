import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_CAPABILITIES = "contracts/native-edit-capabilities.json";
const DEFAULT_CONFORMANCE = "contracts/native-mutation-conformance.json";

export function buildConformancePlan(capabilities, conformance, options = {}) {
  const enginePatchLevel =
    options.enginePatchLevel ?? conformance.enginePatchLevel;
  if (!Number.isInteger(enginePatchLevel) || enginePatchLevel < 0)
    throw new Error("enginePatchLevel must be a non-negative integer.");
  const requestedFamilies = options.families?.length
    ? new Set(options.families)
    : null;
  const scenarioOrder = conformance.executionOrder;
  if (!Array.isArray(scenarioOrder))
    throw new Error("Conformance executionOrder must be an array.");
  const knownScenarios = Object.keys(conformance.scenarios);
  const duplicateScenarios = scenarioOrder.filter(
    (name, index) => scenarioOrder.indexOf(name) !== index,
  );
  const unknownScenarios = scenarioOrder.filter(
    (name) => !conformance.scenarios[name],
  );
  const unorderedScenarios = knownScenarios.filter(
    (name) => !scenarioOrder.includes(name),
  );
  if (
    duplicateScenarios.length ||
    unknownScenarios.length ||
    unorderedScenarios.length
  )
    throw new Error(
      `Invalid conformance executionOrder: duplicates=${
        [...new Set(duplicateScenarios)].join(",") || "none"
      }; unknown=${unknownScenarios.join(",") || "none"}; missing=${unorderedScenarios.join(",") || "none"}.`,
    );
  const scenarioRank = new Map(
    scenarioOrder.map((name, index) => [name, index]),
  );
  const operations = Object.entries(capabilities.mutationModel.operations)
    .filter(
      ([, operation]) =>
        operation.availability !== "format_excluded" &&
        !(
          options.runtime &&
          (operation.unavailableIn ?? []).includes(options.runtime)
        ) &&
        operation.minEnginePatch <= enginePatchLevel &&
        (!requestedFamilies || requestedFamilies.has(operation.family)),
    )
    .sort(([left], [right]) => left.localeCompare(right));
  const unknownFamilies = [...(requestedFamilies ?? [])].filter(
    (family) => !capabilities.mutationModel.families[family],
  );
  if (unknownFamilies.length)
    throw new Error(`Unknown mutation families: ${unknownFamilies.join(", ")}`);

  const selectedFamilyNames = [
    ...new Set(operations.map(([, operation]) => operation.family)),
  ].sort();
  const scenarioNames = new Set();
  const nativeTestNames = new Set();
  const families = {};
  for (const familyName of selectedFamilyNames) {
    const family = capabilities.mutationModel.families[familyName];
    const fixture = conformance.fixtures[family.fixture];
    if (!fixture)
      throw new Error(
        `Mutation family ${familyName} references missing fixture ${family.fixture}.`,
      );
    const providedGates = new Set(
      Object.entries(conformance.genericProviders)
        .filter(
          ([, provider]) =>
            !provider.families || provider.families.includes(familyName),
        )
        .map(([gate]) => gate),
    );
    for (const scenarioName of fixture.scenarios) {
      const scenario = conformance.scenarios[scenarioName];
      if (!scenario)
        throw new Error(
          `Fixture ${family.fixture} references missing scenario ${scenarioName}.`,
        );
      if (scenario.minEnginePatch > enginePatchLevel) continue;
      scenarioNames.add(scenarioName);
      for (const gate of scenario.proves) providedGates.add(gate);
    }
    for (const nativeTestName of fixture.nativeTests) {
      const nativeTest = conformance.nativeTests[nativeTestName];
      if (!nativeTest)
        throw new Error(
          `Fixture ${family.fixture} references missing native test ${nativeTestName}.`,
        );
      if (nativeTest.minEnginePatch > enginePatchLevel) continue;
      nativeTestNames.add(nativeTestName);
      for (const gate of nativeTest.proves) providedGates.add(gate);
    }
    const missingGates = family.verification.filter(
      (gate) => !providedGates.has(gate),
    );
    families[familyName] = {
      fixture: family.fixture,
      operations: operations
        .filter(([, operation]) => operation.family === familyName)
        .map(([name]) => name),
      requiredGates: family.verification,
      providedGates: [...providedGates].sort(),
      missingGates,
      changeBudget: family.changeBudget,
      scenarios: fixture.scenarios.filter(
        (name) =>
          conformance.scenarios[name].minEnginePatch <= enginePatchLevel,
      ),
      nativeTests: fixture.nativeTests.filter(
        (name) =>
          conformance.nativeTests[name].minEnginePatch <= enginePatchLevel,
      ),
    };
  }

  const scenarios = Object.fromEntries(
    [...scenarioNames]
      .sort((left, right) => scenarioRank.get(left) - scenarioRank.get(right))
      .map((name) => [name, conformance.scenarios[name]]),
  );
  const nativeTests = Object.fromEntries(
    [...nativeTestNames]
      .sort()
      .map((name) => [name, conformance.nativeTests[name]]),
  );
  const missing = Object.entries(families).flatMap(([family, value]) =>
    value.missingGates.map((gate) => ({ family, gate })),
  );
  return {
    contractVersion: conformance.version,
    mutationContractVersion: capabilities.mutationModel.version,
    enginePatchLevel,
    runtime: options.runtime ?? null,
    summary: {
      operations: operations.length,
      families: selectedFamilyNames.length,
      scenarios: Object.keys(scenarios).length,
      nativeTests: Object.keys(nativeTests).length,
      missingGates: missing.length,
      complete: missing.length === 0,
    },
    genericProviders: conformance.genericProviders,
    families,
    scenarios,
    nativeTests,
    missing,
  };
}

export async function writeConformancePlan({
  capabilitiesPath = DEFAULT_CAPABILITIES,
  conformancePath = DEFAULT_CONFORMANCE,
  outputPath,
  enginePatchLevel,
  families,
  requireComplete = false,
}) {
  const capabilities = JSON.parse(
    await fs.readFile(path.resolve(capabilitiesPath), "utf8"),
  );
  const conformance = JSON.parse(
    await fs.readFile(path.resolve(conformancePath), "utf8"),
  );
  const plan = buildConformancePlan(capabilities, conformance, {
    enginePatchLevel,
    families,
  });
  if (outputPath) {
    const output = path.resolve(outputPath);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, `${JSON.stringify(plan, null, 2)}\n`);
  }
  if (requireComplete && !plan.summary.complete)
    throw new Error(
      `Conformance plan has ${plan.summary.missingGates} uncovered required gates.`,
    );
  return plan;
}

function parseArguments(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--") continue;
    if (value === "--capabilities") parsed.capabilitiesPath = argv[++index];
    else if (value === "--conformance") parsed.conformancePath = argv[++index];
    else if (value === "--output") parsed.outputPath = argv[++index];
    else if (value === "--engine-patch-level")
      parsed.enginePatchLevel = Number(argv[++index]);
    else if (value === "--families")
      parsed.families = argv[++index].split(",").filter(Boolean);
    else if (value === "--require-complete") parsed.requireComplete = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  return parsed;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const plan = await writeConformancePlan(
      parseArguments(process.argv.slice(2)),
    );
    process.stdout.write(`${JSON.stringify(plan.summary, null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
