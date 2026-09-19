import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultContractPath = path.resolve(
  moduleDirectory,
  "../../contracts/native-edit-capabilities.json",
);
const defaultOutputPath = path.resolve(
  moduleDirectory,
  "extension/mutation-contract.generated.js",
);

export const runtimeMutationContracts = (capabilities) => {
  const { domains, families, operations } = capabilities.mutationModel;
  return Object.fromEntries(
    Object.entries(operations).map(([operation, contract]) => {
      const family = families[contract.family];
      const domain = domains[family.domain];
      return [
        operation,
        {
          family: contract.family,
          domain: family.domain,
          atomicBoundary: domain.atomicBoundary,
          target: contract.target,
          execution: contract.execution,
          undoProvider: family.undoProvider,
          identityEffect: contract.identityEffect,
          availability: contract.availability,
          minEnginePatch: contract.minEnginePatch,
          unavailableIn: contract.unavailableIn ?? [],
        },
      ];
    }),
  );
};

export const renderRuntimeMutationContract = (capabilities) => {
  const entries = Object.entries(runtimeMutationContracts(capabilities)).map(
    ([operation, contract]) =>
      `  ${JSON.stringify(operation)}: ${JSON.stringify(contract)},`,
  );
  return [
    "/* Generated from contracts/native-edit-capabilities.json. Do not edit. */",
    "// prettier-ignore",
    "globalThis.spellbookMutationContracts = Object.freeze({",
    ...entries,
    "});",
    "",
  ].join("\n");
};

export const generateRuntimeMutationContract = (
  contractPath = defaultContractPath,
  outputPath = defaultOutputPath,
) => {
  const capabilities = JSON.parse(fs.readFileSync(contractPath, "utf8"));
  fs.writeFileSync(outputPath, renderRuntimeMutationContract(capabilities));
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const contractIndex = process.argv.indexOf("--contract");
  const outputIndex = process.argv.indexOf("--output");
  generateRuntimeMutationContract(
    contractIndex >= 0
      ? path.resolve(process.argv[contractIndex + 1])
      : undefined,
    outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1]) : undefined,
  );
}
