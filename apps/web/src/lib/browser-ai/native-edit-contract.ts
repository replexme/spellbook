import capabilities from "../../../../../contracts/native-edit-capabilities.json";

/*
 * The bounded edit operations the AI may send, grouped the way the editor
 * enforces them. Same contract file the server's change budget reads.
 */

type OperationContract = {
  family: string;
  target: string;
  execution: string;
  identityEffect: string;
  availability: string;
  minEnginePatch: number;
};

export const nativeEditContract = capabilities as unknown as {
  transaction: { maxCommands: number; ordering: string };
  operationGroups: Record<
    "document" | "slide" | "create" | "multiElement" | "element",
    string[]
  >;
  mutationModel: { operations: Record<string, OperationContract> };
  toolInputSchema: Record<string, unknown>;
};

const operations = nativeEditContract.mutationModel.operations;
const executable = Object.entries(operations).filter(
  ([, operation]) => operation.availability !== "format_excluded",
);
const operationsWhere = (test: (operation: OperationContract) => boolean) =>
  new Set(
    executable.filter(([, operation]) => test(operation)).map(([name]) => name),
  );

export const nativeDocumentOperations = new Set(
  nativeEditContract.operationGroups.document,
);
export const nativeSlideOperations = new Set(
  nativeEditContract.operationGroups.slide,
);
export const nativeCreateOperations = new Set(
  nativeEditContract.operationGroups.create,
);
export const nativeMultiElementOperations = new Set(
  nativeEditContract.operationGroups.multiElement,
);
export const nativeElementOperations = new Set(
  nativeEditContract.operationGroups.element,
);
export const nativeIdentityReplacingOperations = operationsWhere(
  (operation) => operation.identityEffect === "replace",
);
export const nativePlatformAssetOperations = operationsWhere(
  (operation) => operation.execution === "platform_asset",
);
export const nativeEditOperationCount = executable.length;

export const nativeBatchEditSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    commands: {
      type: "array",
      minItems: 1,
      maxItems: nativeEditContract.transaction.maxCommands,
      items: nativeEditContract.toolInputSchema,
    },
    dryRun: { type: "boolean" },
  },
  required: ["commands", "dryRun"],
};
