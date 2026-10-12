/* SPDX-License-Identifier: MPL-2.0 */
// Canonical operation metadata supplies every provider and the editor guard.
const nativeEditContract = require("./native-edit-capabilities.json");
const operations = nativeEditContract.mutationModel.operations;
const exportsMap = { nativeEditContract };
for (const [group, names] of Object.entries(
  nativeEditContract.operationGroups,
)) {
  const name = {
    document: "nativeDocumentOperations",
    slide: "nativeSlideOperations",
    create: "nativeCreateOperations",
    multiElement: "nativeMultiElementOperations",
    element: "nativeElementOperations",
  }[group];
  exportsMap[name] = new Set(names);
}
exportsMap.nativePlatformAssetOperations = new Set(
  Object.keys(operations).filter(
    (op) => operations[op].execution === "platform_asset",
  ),
);
exportsMap.nativeIdentityReplacingOperations = new Set(
  Object.keys(operations).filter(
    (op) => operations[op].identityEffect === "replace",
  ),
);
exportsMap.nativeEditOperationCount = Object.keys(operations).length;
exportsMap.nativeBatchEditSchema = {
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
const assetFields = new Set([
  "op",
  ...[...exportsMap.nativePlatformAssetOperations].flatMap(
    (op) => operations[op].arguments,
  ),
]);
exportsMap.nativeAssetEditSchema = {
  ...nativeEditContract.toolInputSchema,
  properties: Object.fromEntries(
    Object.entries(nativeEditContract.toolInputSchema.properties).filter(
      ([key]) => assetFields.has(key),
    ),
  ),
  required: [...assetFields],
};
exportsMap.nativeAssetEditSchema.properties.op = {
  ...nativeEditContract.toolInputSchema.properties.op,
  enum: [...exportsMap.nativePlatformAssetOperations],
};
/**
 * The edit tools for an engine that runs `supportedOperations` (all
 * operations when the engine does not say): the batch and asset input
 * schemas offer only those operations and their fields, and
 * `operationArguments` names each one's fields. The model is never offered
 * an operation the open document's engine would refuse.
 */
function editToolsFor(supportedOperations) {
  const supported =
    Array.isArray(supportedOperations) && supportedOperations.length
      ? new Set(supportedOperations)
      : null;
  // The published tool operations, in their published order.
  const usable = nativeEditContract.toolInputSchema.properties.op.enum.filter(
    (op) => operations[op] && (!supported || supported.has(op)),
  );
  const schemaFor = (ops) => {
    const fields = new Set([
      "op",
      ...ops.flatMap((op) => operations[op].arguments ?? []),
    ]);
    const base = nativeEditContract.toolInputSchema;
    return {
      ...base,
      properties: {
        ...Object.fromEntries(
          Object.entries(base.properties).filter(([key]) => fields.has(key)),
        ),
        op: { ...base.properties.op, enum: ops },
      },
      required: base.required.filter((key) => fields.has(key)),
    };
  };
  const batchOps = usable.filter(
    (op) => !exportsMap.nativePlatformAssetOperations.has(op),
  );
  const assetOps = usable.filter((op) =>
    exportsMap.nativePlatformAssetOperations.has(op),
  );
  return {
    operations: usable,
    operationArguments: Object.fromEntries(
      usable.map((op) => [op, operations[op].arguments]),
    ),
    batchSchema: {
      ...exportsMap.nativeBatchEditSchema,
      properties: {
        ...exportsMap.nativeBatchEditSchema.properties,
        commands: {
          ...exportsMap.nativeBatchEditSchema.properties.commands,
          items: schemaFor(batchOps),
        },
      },
    },
    assetSchema: assetOps.length ? schemaFor(assetOps) : null,
  };
}
exportsMap.editToolsFor = editToolsFor;
function validateOperationArguments(command) {
  if (!command || typeof command !== "object" || Array.isArray(command))
    throw Error("native_command_invalid");
  const operation = operations[command.op];
  if (!operation || !Array.isArray(operation.arguments))
    throw Error("native_operation_unavailable");
  const allowed = new Set(["op", ...operation.arguments]);
  for (const [key, value] of Object.entries(command)) {
    if (
      !(key in nativeEditContract.toolInputSchema.properties) ||
      (value != null && !allowed.has(key))
    )
      throw Error(`native_operation_argument_unused:${command.op}:${key}`);
  }
  if (
    command.op === "crop_image" &&
    command.geometry != null &&
    !["rectangle", "ellipse"].includes(command.geometry)
  )
    throw Error("native_image_shape_invalid");
  return true;
}
exportsMap.validateOperationArguments = validateOperationArguments;
/** The open document's engine runs `operation` (it lists it in supportedOperations). */
exportsMap.engineSupports = (engine, operation) =>
  !!operations[operation] &&
  Array.isArray(engine?.supportedOperations) &&
  engine.supportedOperations.includes(operation);
module.exports = exportsMap;
