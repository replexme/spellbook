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
exportsMap.nativeEditOperationCount = Object.values(operations).filter(
  (op) => op.availability !== "format_excluded",
).length;
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
function validateOperationArguments(command) {
  if (!command || typeof command !== "object" || Array.isArray(command))
    throw Error("native_command_invalid");
  const operation = operations[command.op];
  if (
    !operation ||
    operation.availability === "format_excluded" ||
    !Array.isArray(operation.arguments)
  )
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
exportsMap.engineSupports = (engine, operation) => {
  const metadata = operations[operation];
  const match = /^(?:browser-)?undo-v([1-9][0-9]*)$/.exec(
    engine.patchLevel ?? "",
  );
  return (
    !!metadata &&
    ((metadata.minEnginePatch ?? 0) <= Number(match?.[1] ?? 0) ||
      engine.supportedOperations.includes(operation))
  );
};
module.exports = exportsMap;
