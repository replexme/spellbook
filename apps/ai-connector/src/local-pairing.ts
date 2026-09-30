import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

const MIN_SECRET_BYTES = 32;
const MIN_CHALLENGE_LENGTH = 32;
const MAX_CHALLENGE_LENGTH = 128;
export type PairingIntent = "codex" | "claude";

interface PendingPairing {
  id: string;
  origin: string;
  challenge: string;
  intent: PairingIntent;
  confirmationSecret: string;
  expiresAt: number;
}

interface SessionClaims {
  version: 1;
  origin: string;
  expiresAt: number;
  id: string;
}

export interface PairingRequest {
  id: string;
  origin: string;
  challenge: string;
  intent: PairingIntent;
  expiresAt: number;
}

export interface PairingApproval extends PairingRequest {
  confirmationSecret: string;
}

export interface PairedSession {
  token: string;
  origin: string;
  challenge: string;
  intent: PairingIntent;
  expiresAt: number;
}

export class LocalPairingAuthority {
  private readonly allowedOrigins: ReadonlySet<string>;
  private readonly pending = new Map<string, PendingPairing>();
  private readonly sessions = new Map<string, SessionClaims>();

  constructor(
    private readonly secret: Buffer,
    allowedOrigins: readonly string[] = [],
    private readonly now: () => number = Date.now,
    private readonly pendingTtlMs = 2 * 60 * 1000,
    private readonly sessionTtlMs = 6 * 60 * 60 * 1000,
  ) {
    if (secret.byteLength < MIN_SECRET_BYTES)
      throw new Error("local_pairing_secret_too_short");
    const normalized = allowedOrigins.map(normalizeAllowedOrigin);
    if (new Set(normalized).size !== normalized.length)
      throw new Error("invalid_local_connector_origins");
    this.allowedOrigins = new Set(normalized);
  }

  begin(
    rawOrigin: string,
    challenge: string,
    intent: PairingIntent = "codex",
  ): PairingRequest {
    this.cleanup();
    const origin = this.requireAllowedOrigin(rawOrigin);
    if (this.pending.size >= 32) throw new Error("too_many_pairing_requests");
    if (
      challenge.length < MIN_CHALLENGE_LENGTH ||
      challenge.length > MAX_CHALLENGE_LENGTH ||
      !/^[A-Za-z0-9_-]+$/.test(challenge)
    )
      throw new Error("invalid_pairing_challenge");
    const pairing: PendingPairing = {
      id: randomUUID(),
      origin,
      challenge,
      intent,
      confirmationSecret: randomBytes(32).toString("base64url"),
      expiresAt: this.now() + this.pendingTtlMs,
    };
    this.pending.set(pairing.id, pairing);
    return publicPairing(pairing);
  }

  approval(id: string): PairingApproval {
    this.cleanup();
    const pairing = this.pending.get(id);
    if (!pairing) throw new Error("pairing_request_not_found");
    return {
      ...publicPairing(pairing),
      confirmationSecret: pairing.confirmationSecret,
    };
  }

  confirm(id: string, confirmationSecret: string): PairedSession {
    this.cleanup();
    const pairing = this.pending.get(id);
    if (!pairing) throw new Error("pairing_request_not_found");
    if (!safeEqual(confirmationSecret, pairing.confirmationSecret))
      throw new Error("invalid_pairing_confirmation");
    this.pending.delete(id);
    const claims: SessionClaims = {
      version: 1,
      origin: pairing.origin,
      expiresAt: this.now() + this.sessionTtlMs,
      id: randomBytes(24).toString("base64url"),
    };
    this.sessions.set(claims.id, claims);
    return {
      token: this.sign(claims),
      origin: pairing.origin,
      challenge: pairing.challenge,
      intent: pairing.intent,
      expiresAt: claims.expiresAt,
    };
  }

  verify(rawOrigin: string, token: string): SessionClaims {
    this.cleanup();
    const origin = this.requireAllowedOrigin(rawOrigin);
    const [encoded, givenSignature, extra] = token.split(".");
    if (!encoded || !givenSignature || extra)
      throw new Error("invalid_connector_session");
    const expectedSignature = this.signature(encoded);
    if (!safeEqual(givenSignature, expectedSignature))
      throw new Error("invalid_connector_session");
    let claims: SessionClaims;
    try {
      claims = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    } catch {
      throw new Error("invalid_connector_session");
    }
    if (
      claims.version !== 1 ||
      claims.origin !== origin ||
      !Number.isSafeInteger(claims.expiresAt) ||
      claims.expiresAt <= this.now() ||
      typeof claims.id !== "string" ||
      this.sessions.get(claims.id)?.origin !== origin
    )
      throw new Error("invalid_connector_session");
    return claims;
  }

  revoke(rawOrigin: string, token: string): void {
    const claims = this.verify(rawOrigin, token);
    this.sessions.delete(claims.id);
  }

  validateOrigin(rawOrigin: string): string {
    return this.requireAllowedOrigin(rawOrigin);
  }

  private requireAllowedOrigin(rawOrigin: string): string {
    const origin = normalizeAllowedOrigin(rawOrigin);
    if (this.allowedOrigins.size > 0 && !this.allowedOrigins.has(origin))
      throw new Error("connector_origin_not_allowed");
    return origin;
  }

  private sign(claims: SessionClaims): string {
    const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return `${encoded}.${this.signature(encoded)}`;
  }

  private signature(encoded: string): string {
    return createHmac("sha256", this.secret)
      .update(encoded)
      .digest("base64url");
  }

  private cleanup(): void {
    const current = this.now();
    for (const [id, pairing] of this.pending)
      if (pairing.expiresAt <= current) this.pending.delete(id);
    for (const [id, session] of this.sessions)
      if (session.expiresAt <= current) this.sessions.delete(id);
  }
}

function publicPairing(pairing: PendingPairing): PairingRequest {
  return {
    id: pairing.id,
    origin: pairing.origin,
    challenge: pairing.challenge,
    intent: pairing.intent,
    expiresAt: pairing.expiresAt,
  };
}

function normalizeAllowedOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid_connector_origin");
  }
  if (url.origin !== value.replace(/\/$/, "") || url.username || url.password)
    throw new Error("invalid_connector_origin");
  const localHttp =
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !localHttp)
    throw new Error("insecure_connector_origin");
  return url.origin;
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}
