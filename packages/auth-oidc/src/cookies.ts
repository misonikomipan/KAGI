import { EncryptJWT, jwtDecrypt, type JWTPayload } from "jose";

/**
 * Stateless, encrypted cookies (JWE, dir + A256GCM). The key is derived from a secret string,
 * so rotating KAGI_SESSION_SECRET signs everyone out — which is also the "revoke all" switch.
 */
export class CookieSealer {
  readonly #key: Promise<Uint8Array>;

  constructor(secret: string) {
    if (secret.length < 32) throw new Error("kagi: session secret must be at least 32 characters");
    this.#key = crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(secret))
      .then((d) => new Uint8Array(d));
  }

  async seal(payload: JWTPayload, ttlSeconds: number, purpose: string): Promise<string> {
    return new EncryptJWT({ ...payload, pur: purpose })
      .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
      .setIssuedAt()
      .setExpirationTime(`${Math.floor(ttlSeconds)}s`)
      .encrypt(await this.#key);
  }

  /** null when missing, tampered, expired or sealed for another purpose. */
  async open<T extends object>(value: string | undefined, purpose: string): Promise<(T & JWTPayload) | null> {
    if (!value) return null;
    try {
      const { payload } = await jwtDecrypt(value, await this.#key, {
        keyManagementAlgorithms: ["dir"],
        contentEncryptionAlgorithms: ["A256GCM"],
      });
      return payload.pur === purpose ? (payload as T & JWTPayload) : null;
    } catch {
      return null;
    }
  }
}

/** Names of all cookies the request carries. */
export function cookieNames(req: Request): string[] {
  return (req.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => {
      const i = part.indexOf("=");
      return i > 0 ? part.slice(0, i).trim() : "";
    })
    .filter(Boolean);
}

export function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

export interface CookieOptions {
  secure: boolean;
  path?: string;
  maxAge?: number;
}

export function serializeCookie(name: string, value: string, o: CookieOptions): string {
  const parts = [`${name}=${value}`, `Path=${o.path ?? "/"}`, "HttpOnly", "SameSite=Lax"];
  if (o.secure) parts.push("Secure");
  if (o.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(o.maxAge)}`);
  return parts.join("; ");
}
