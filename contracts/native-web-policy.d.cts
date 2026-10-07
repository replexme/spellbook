export const WEB_FETCHES_PER_TURN: number;
export const WEB_SEARCHES_PER_TURN: number;
export const WEB_TOOLS_INSTRUCTION: string;
export const EDIT_REQUEST_INSTRUCTION: string;
export const UNTRUSTED_PAGE_NOTICE: string;
export const WEB_SEARCH_DESCRIPTION: string;
export const FETCH_WEB_PAGE_DESCRIPTION: string;
export function pageKey(raw: string): string | null;
export class TurnWebAccess {
  constructor(requestText: string);
  searchQuery(args: unknown): string;
  allowResults(results: Array<{ url?: string }>): void;
  pageAddress(args: unknown): string;
}
