/**
 * Token refresh loop: one member failing must not abort the loop, and a
 * permanent failure (revoked access / account type change → error 190) marks
 * the row instead of being retried forever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptToken, hashBearerToken } from "../src/crypto.js";
import type { TeamMemberRow } from "../src/db.js";

const DAY_MS = 864e5;

function row(id: string, name: string, token: string, expiresInDays: number): TeamMemberRow {
  return {
    id,
    name,
    token_hash: hashBearerToken(`bearer-${id}`),
    ig_user_id: `178${id}`,
    ig_username: name.toLowerCase(),
    ig_access_token_encrypted: encryptToken(token),
    ig_token_expires_at: new Date(Date.now() + expiresInDays * DAY_MS).toISOString(),
    revoked_at: null,
    refresh_failed_at: null,
    refresh_error: null,
    created_at: new Date().toISOString(),
  };
}

const updates: Array<{ id: string; expiresAt: Date }> = [];
const permanentFailures: Array<{ id: string; message: string }> = [];

vi.mock("../src/db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db.js")>();
  return {
    ...actual,
    listActiveMembers: vi.fn(async () => [
      row("a", "Revoked-Rita", "TOKEN_REVOKED", 10), // in window; permanent 190 — FIRST in the loop
      row("b", "Healthy-Hank", "TOKEN_GOOD", 15), // in window; must still refresh after Rita fails
      row("c", "NotDue-Nora", "TOKEN_FRESH", 45), // >25d runway → left alone, not called
    ]),
    updateMemberIgToken: vi.fn(async (id: string, _enc: string, expiresAt: Date) => {
      updates.push({ id, expiresAt });
    }),
    markMemberRefreshFailed: vi.fn(async (id: string, message: string) => {
      permanentFailures.push({ id, message });
    }),
  };
});

const { refreshAllTokens } = await import("../src/refresh.js");

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: URL | Request | string): Promise<Response> => {
      const url = new URL(String(input));
      expect(url.host).toBe("graph.instagram.com");
      expect(url.pathname).toBe("/refresh_access_token"); // unversioned path
      expect(url.searchParams.get("grant_type")).toBe("ig_refresh_token");
      const token = url.searchParams.get("access_token");
      if (token === "TOKEN_REVOKED") {
        return new Response(
          JSON.stringify({
            error: { message: "Error validating access token: revoked.", type: "OAuthException", code: 190 },
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ access_token: `${token}_ROTATED`, token_type: "bearer", expires_in: 5184000 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

/** Every URL the stubbed fetch was called with, as strings. */
function fetchCalls(): string[] {
  const mock = globalThis.fetch as unknown as { mock: { calls: unknown[][] } };
  return mock.mock.calls.map((c) => String(c[0]));
}

describe("refreshAllTokens", () => {
  it("continues past a permanent failure, refreshes due members, leaves not-due ones untouched", async () => {
    const report = await refreshAllTokens();

    // Rita failed permanently → marked, not retried forever
    expect(report.failedPermanent).toHaveLength(1);
    expect(report.failedPermanent[0]!.name).toContain("Revoked-Rita");
    expect(permanentFailures.map((f) => f.id)).toEqual(["a"]);

    // Hank was still refreshed even though Rita (earlier in the loop) failed
    expect(report.refreshed).toHaveLength(1);
    expect(report.refreshed[0]).toContain("Healthy-Hank");
    expect(updates.map((u) => u.id)).toEqual(["b"]);
    // New expiry ≈ 60 days out
    const days = (updates[0]!.expiresAt.getTime() - Date.now()) / DAY_MS;
    expect(days).toBeGreaterThan(59);
    expect(days).toBeLessThan(61);

    // Nora has >25 days of runway → not due; she is never even called.
    expect(report.skippedNotDue).toHaveLength(1);
    expect(report.skippedNotDue[0]).toContain("NotDue-Nora");
    expect(fetchCalls().some((u) => u.includes("TOKEN_FRESH"))).toBe(false);

    expect(report.failedTransient).toHaveLength(0);
    expect(report.skippedTooFresh).toHaveLength(0);
  });
});
