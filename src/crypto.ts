import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { requireEnv } from "./env.js";

/**
 * AES-256-GCM for Instagram access tokens at rest, SHA-256 for bearer token
 * hashes. TOKEN_ENCRYPTION_KEY is 32 bytes, base64 (openssl rand -base64 32).
 *
 * Encrypted format: "v1." + base64( iv[12] || authTag[16] || ciphertext ).
 * The version prefix leaves room for key rotation later without guessing at
 * blob layouts.
 */

const VERSION_PREFIX = "v1.";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function encryptionKey(): Buffer {
  const key = Buffer.from(requireEnv("TOKEN_ENCRYPTION_KEY"), "base64");
  if (key.length !== 32) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes. " +
        "Generate one with: openssl rand -base64 32",
    );
  }
  return key;
}

export function encryptToken(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return VERSION_PREFIX + Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

export function decryptToken(encrypted: string): string {
  if (!encrypted.startsWith(VERSION_PREFIX)) {
    throw new Error("Unrecognized encrypted token format (expected v1 prefix).");
  }
  const blob = Buffer.from(encrypted.slice(VERSION_PREFIX.length), "base64");
  if (blob.length < IV_LENGTH + TAG_LENGTH + 1) {
    throw new Error("Encrypted token blob is truncated.");
  }
  const iv = blob.subarray(0, IV_LENGTH);
  const tag = blob.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = blob.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
    "utf8",
  );
}

/** SHA-256 hex digest of a presented bearer token. Raw tokens are never stored. */
export function hashBearerToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Constant-time comparison of two hex digests. Used instead of === when
 * comparing the presented token's hash against the stored hash, so the
 * comparison itself leaks no timing information.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * New member bearer token: 256 bits of entropy, base64url, with a recognizable
 * prefix so a leaked token is identifiable in scanners and logs.
 */
export function generateBearerToken(): string {
  return "igmcp_" + randomBytes(32).toString("base64url");
}
