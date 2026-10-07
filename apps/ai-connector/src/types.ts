export interface RpcNotification {
  method: string;
  params?: unknown;
}

export interface AccountReadResult {
  account: null | {
    type: string;
    email?: string | null;
    planType?: string | null;
  };
  requiresOpenaiAuth: boolean;
}

export interface DeviceLoginResult {
  type: "chatgptDeviceCode";
  loginId: string;
  verificationUrl: string;
  userCode: string;
}

export interface BrowserLoginResult {
  type: "chatgpt";
  loginId: string;
  authUrl: string;
}

export interface AiJob {
  modelSettings?: ModelSettings;
  jobId: string;
  callbackUrl: string;
  mode: "plan" | "review";
  email: string;
  storageNamespace: string;
  requestText: string;
  conversational?: boolean;
  execution?: "agent";
  conversationHistory?: Array<{
    request: string;
    response: string | null;
    status: string;
    inputVersionId: string;
  }>;
  selectedElementIds: string[];
  selectedSlideIndexes: number[];
  baseGraphObject: string;
  basePreviewObjects: string[];
  candidateGraphObject?: string;
  candidatePreviewObjects?: string[];
  validationObject?: string;
}

export interface NativeJob {
  activeGoal?: import("../../../contracts/native-goal.cjs").ActiveGoal | null;
  jobId: string;
  callbackUrl: string;
  toolUrl: string;
  mode: "native";
  email: string;
  storageNamespace: string;
  baseGraphObject: string;
  sessionId: string;
  turnId: string;
  requestText: string;
  conversationHistory?: Array<{
    request: string;
    response: string | null;
    status: "completed" | "failed" | "cancelled";
  }>;
  permissionMode: "read_only" | "selection" | "slides" | "document";
  modelSettings?: ModelSettings;
}

export interface LocalNativeJob extends Omit<NativeJob, "email"> {
  capability: string;
}

export interface AiWorkerCallback {
  jobId: string;
  status: "succeeded" | "failed";
  mode: "plan" | "review" | "native";
  result?: unknown;
  error?: string;
}
import type { ModelSettings } from "../../../contracts/ai-models.js";
export type { AvailableModel } from "../../../contracts/ai-models.js";
