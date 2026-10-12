/** The shared edit contract (native-edit-capabilities.json) as the tools read it. */
export interface NativeEditOperation {
  family: string;
  target: string;
  execution: string;
  identityEffect:
    | "preserve"
    | "create"
    | "delete"
    | "reorder"
    | "reparent"
    | "replace";
  arguments: string[];
  changeBudget?: unknown;
  allowPartCreationOrDeletion?: boolean;
  description: string;
}
export interface NativeEditContract {
  version: string;
  coordinateUnit: string;
  nativeUndoRequired: boolean;
  aiExposure: { operationCount: number; policy: string };
  transaction: {
    maxCommands: number;
    supportsDryRun: boolean;
    atomicByDefault: boolean;
    targetResolution: string;
    identityReplacingOperations: string[];
    ordering: string;
  };
  mutationModel: {
    version: string;
    domains: Record<string, { description: string }>;
    changeBudgetContract: Record<string, unknown>;
    families: Record<string, Record<string, unknown>>;
    operations: Record<string, NativeEditOperation>;
  };
  operationGroups: {
    document: string[];
    slide: string[];
    create: string[];
    multiElement: string[];
    element: string[];
  };
  toolInputSchema: Record<string, unknown> & {
    properties: Record<string, unknown> & { op: { enum: string[] } };
    required: string[];
  };
}
export const nativeEditContract: NativeEditContract;
export const nativeDocumentOperations: Set<string>;
export const nativeSlideOperations: Set<string>;
export const nativeCreateOperations: Set<string>;
export const nativeMultiElementOperations: Set<string>;
export const nativeElementOperations: Set<string>;
export const nativePlatformAssetOperations: Set<string>;
export const nativeIdentityReplacingOperations: Set<string>;
export const nativeEditOperationCount: number;
export const nativeBatchEditSchema: Record<string, unknown>;
export const nativeAssetEditSchema: Record<string, unknown>;
export function editToolsFor(supportedOperations?: string[] | null): {
  operations: string[];
  operationArguments: Record<string, string[]>;
  batchSchema: Record<string, unknown>;
  assetSchema: Record<string, unknown> | null;
};
export function validateOperationArguments(command: unknown): true;
export function engineSupports(
  engine: { supportedOperations?: string[] } | null | undefined,
  operation: string,
): boolean;
