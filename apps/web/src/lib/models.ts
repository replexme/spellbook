export interface Session {
  accountId: string;
  email: string;
  admin: true;
  token: string;
}

export interface ElementNode {
  elementId: string;
  shapeId: number;
  kind: string;
  name: string;
  text: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  zIndex: number;
  editable: boolean;
  unsupportedReason: string | null;
  sourceHash: string;
  tableCells?: string[][] | null;
  flipHorizontal?: boolean;
  flipVertical?: boolean;
}

export interface SlideGraph {
  slideIndex: number;
  partUri: string;
  previewObject: string | null;
  supportGrade: "A" | "B" | "C" | "D";
  elements: ElementNode[];
  warnings: string[];
}

export interface ElementGraph {
  contractVersion: "1.0";
  documentSha256: string;
  slideWidthEmu: number;
  slideHeightEmu: number;
  fontInventoryAvailable?: boolean;
  declaredFonts?: string[];
  missingFonts?: string[];
  fontSubstitutions?: Array<{
    original: string;
    substituted: string;
  }>;
  rendererName?: string;
  rendererVersion?: string;
  slides: SlideGraph[];
  warnings: string[];
}

export interface WorkerCallback {
  jobId: string;
  status: "succeeded" | "failed";
  mode?: "plan" | "review" | "native";
  outputs?: {
    graphObject: string;
    scanObject?: string | null;
    validationObject?: string | null;
    documentObject?: string | null;
    slideCount: number;
    documentSha256: string;
  } | null;
  result?: unknown;
  error?: string | null;
}

export interface PackageChangeBudgetReport {
  contractVersion: "1.0";
  valid: boolean;
  baselineDocumentSha256: string;
  candidateDocumentSha256: string;
  changes: Array<{
    part: string;
    category: string;
    changeKind: string;
    inTargetScope: boolean;
  }>;
  errors: string[];
}
