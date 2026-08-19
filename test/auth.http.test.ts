/**
 * Acceptance test 1 (end-to-end): the same rejection rules as auth.test.ts, but
 * driven through the real exported HTTP handler — createMcpHandler wrapped in
 * withMcpAuth({ required: true }) — so the assertions are on actual HTTP status
 * codes rather than on verifyBearerToken's return value.
 *
 * Only the database is mocked. Nothing here stubs the transport, the auth
 * wrapper, or the tool registry.
 */
import { describe, expect, it, vi } from "vitest";
import { encryptToken, hashBearerToken } from "../src/crypto.js";
import type { TeamMemberRow } from "../src/db.js";

const GOOD_TOKEN = "igmcp_good_member_token_0123456789abcdef";
const REVOKED_TOKEN = "igmcp_revoked_member_token_0123456789ab";

function memberRow(overrides: Partial<TeamMemberRow>): TeamMemberRow {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    name: "Ada",
    token_hash: hashBearerToken(GOOD_TOKEN),
    ig_user_id: "17840000000000001",
    ig_username: "ada.builds",
    ig_access_token_encrypted: encryptToken("IGAAR_fake_instagram_token"),
    ig_token_expires_at: new Date(Date.now() + 50 * 864e5).toISOString(),
    revoked_at: null,
    refresh_failed_at: null,
    refresh_error: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

vi.mock("../src/db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db.js")>();
  return {
    ...actual,
    findMemberByTokenHash: vi.fn(async (hash: string) => {
      if (hash === hashBearerToken(GOOD_TOKEN)) return memberRow({});
      if (hash === hashBearerToken(REVOKED_TOKEN)) {
        return memberRow({
          id: "22222222-2222-2222-2222-222222222222",
          name: "Ben",
          token_hash: hashBearerToken(REVOKED_TOKEN),
          ig_username: "ben.ships",
          revoked_at: new Date(Date.now() - 864e5).toISOString(),
        });
      }
      return null;
    }),
  };
});

const { POST } = await import("../api/mcp.js");

const ENDPOINT = "https://instagram-mcp.test/api/mcp";

/** An MCP initialize request, optionally carrying a bearer token. */
function initializeRequest(token?: string): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (token) headers["authorization"] = `Bearer ${token}`;
  return new Request(ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "vitest", version: "1.0.0" },
      },
    }),
  });
}

describe("HTTP handler auth boundary", () => {
  it("a request with no Authorization header is rejected with 401", async () => {
    const res = await POST(initializeRequest());
    expect(res.status).toBe(401);
  });

  it("an unknown token is rejected with 401", async () => {
    const res = await POST(initializeRequest("igmcp_never_issued_0123456789abcdef"));
    expect(res.status).toBe(401);
  });

  it("a REVOKED member's token is rejected with 401", async () => {
    const res = await POST(initializeRequest(REVOKED_TOKEN));
    expect(res.status).toBe(401);
  });

  it("a revoked token is indistinguishable from an unknown one", async () => {
    const [revoked, unknown] = await Promise.all([
      POST(initializeRequest(REVOKED_TOKEN)),
      POST(initializeRequest("igmcp_never_issued_0123456789abcdef")),
    ]);
    expect(revoked.status).toBe(unknown.status);
    expect(await revoked.text()).toBe(await unknown.text());
  });

  it("a malformed Authorization header (no Bearer scheme) is rejected", async () => {
    const res = await POST(
      new Request(ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: GOOD_TOKEN, // missing the "Bearer " prefix
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("a valid token gets past auth and the server initializes", async () => {
    const res = await POST(initializeRequest(GOOD_TOKEN));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("instagram-publisher");
  });
});
