import { describe, expect, it } from "vitest";
import {
  decryptToken,
  encryptToken,
  generateBearerToken,
  hashBearerToken,
  timingSafeEqualHex,
} from "../src/crypto.js";

describe("crypto", () => {
  it("round-trips a token through AES-256-GCM", () => {
    const secret = "IGAAR" + "x".repeat(120);
    const encrypted = encryptToken(secret);
    expect(encrypted).not.toContain(secret);
    expect(encrypted.startsWith("v1.")).toBe(true);
    expect(decryptToken(encrypted)).toBe(secret);
  });

  it("produces a different ciphertext each time (random IV)", () => {
    expect(encryptToken("same")).not.toBe(encryptToken("same"));
  });

  it("rejects tampered ciphertext (GCM auth tag)", () => {
    const encrypted = encryptToken("secret-token");
    const blob = Buffer.from(encrypted.slice(3), "base64");
    blob[blob.length - 1]! ^= 0xff; // flip a ciphertext bit
    const tampered = "v1." + blob.toString("base64");
    expect(() => decryptToken(tampered)).toThrow();
  });

  it("hashes bearer tokens deterministically, 64 hex chars", () => {
    const token = generateBearerToken();
    const h1 = hashBearerToken(token);
    expect(h1).toBe(hashBearerToken(token));
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates prefixed, high-entropy bearer tokens", () => {
    const t = generateBearerToken();
    expect(t.startsWith("igmcp_")).toBe(true);
    expect(t.length).toBeGreaterThan(40);
    expect(generateBearerToken()).not.toBe(t);
  });

  it("timingSafeEqualHex agrees with equality and rejects length mismatches", () => {
    const a = hashBearerToken("a");
    expect(timingSafeEqualHex(a, a)).toBe(true);
    expect(timingSafeEqualHex(a, hashBearerToken("b"))).toBe(false);
    expect(timingSafeEqualHex(a, a.slice(2))).toBe(false);
    expect(timingSafeEqualHex("", "")).toBe(false);
  });
});
