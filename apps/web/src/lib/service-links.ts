/**
 * Where people read the operator's terms and privacy policy and where they
 * ask for help. A self-hosted install has none of its own, so nothing is
 * linked. The managed service replaces this file with its own pages and
 * support address (see the managed web Dockerfile).
 */
export interface ServiceLinks {
  terms: string | null;
  privacy: string | null;
  supportEmail: string | null;
}

export const serviceLinks: ServiceLinks = {
  terms: null,
  privacy: null,
  supportEmail: null,
};
