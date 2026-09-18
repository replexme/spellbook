/* Client-safe shapes for history, versions and document summaries. */
import type { AiEditLimit } from "./ai-edit-limits";
import type { TurnSummary } from "./native-turn-summary";

export type TurnHistoryItem = {
  id: string;
  requestText: string;
  permissionMode: string;
  status: string;
  assistantText: string | null;
  createdAt: string;
  updatedAt: string;
  summary: TurnSummary | null;
  beforeVersionId: string | null;
  afterVersionId: string | null;
  /** Saved-version previews of each changed slide, before and after the request. */
  savedPreviews: Array<{ slideIndex: number; before: string | null; after: string | null }>;
  /** When the request was undone in the editor; null if it was not. */
  undoneAt: string | null;
};

/**
 * `system`: a save no person changed (the editor's baseline save before AI
 * editing). Same content as its parent; kept for lineage, not listed.
 * `undone`: the save right after an AI request was undone in the editor.
 */
export type VersionOrigin = "original" | "ai" | "manual" | "restored" | "undone" | "system";

export type VersionHistoryItem = {
  id: string;
  parentVersionId: string | null;
  origin: VersionOrigin;
  createdAt: string;
  slideCount: number | null;
  current: boolean;
  turn: { id: string; requestText: string } | null;
  restoredFrom: string | null;
  previews: Array<string | null>;
  /** Size of the saved file; null for versions saved before sizes were kept. */
  bytes: number | null;
};

export type LibraryDocument = {
  id: string;
  fileName: string;
  formatId: string;
  status: string;
  lastError: string | null;
  /** Why the file could not be read ("encrypted_or_legacy_file", ...), if known. */
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
  slideCount: number | null;
  coverUrl: string | null;
};

export type DocumentSummary = {
  id: string;
  fileName: string;
  status: string;
  lastError: string | null;
  failureCode: string | null;
  version: {
    id: string;
    createdAt: string;
    slideCount: number | null;
    rendered: boolean;
    origin: "ai" | "human" | null;
    changeCheck: boolean | null;
    /** Size of the saved file; null for versions saved before sizes were kept. */
    bytes: number | null;
  } | null;
  previews: Array<string | null>;
  fonts: {
    inventoryAvailable: boolean | null;
    missing: string[];
    substitutions: Array<{ original: string; substituted: string }>;
  };
  /** What AI cannot change in this file (see ai-edit-limits.ts). */
  aiLimits: AiEditLimit[];
  /** False until an editor has reported what its engine can do. */
  aiEngineKnown: boolean;
};
