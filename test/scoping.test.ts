/**
 * Acceptance test 6: list_recent_posts returns only the calling member's
 * posts, never a teammate's. The tool is exercised through its real registered
 * callback; the member identity comes only from the auth context, exactly as
 * in production.
 */
import { describe, expect, it, vi } from "vitest";
import type { PostRow } from "../src/db.js";

function post(id: string, memberId: string, caption: string): PostRow {
  return {
    id,
    member_id: memberId,
    ig_media_id: `media-${id}`,
    permalink: `https://www.instagram.com/p/${id}/`,
    caption,
    image_urls: ["https://cdn.example.com/a.png"],
    idempotency_key: `key-${id}`,
    status: "published",
    container_ids: null,
    parent_container_id: null,
    error: null,
    created_at: new Date().toISOString(),
  };
}

const ALL_POSTS = [
  post("a1", "member-a", "Ada's carousel about auth"),
  post("b1", "member-b", "Ben's post about billing"),
  post("a2", "member-a", "Ada's single on idempotency"),
  post("b2", "member-b", "Ben's carousel about caching"),
];

vi.mock("../src/db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db.js")>();
  return {
    ...actual,
    // Same filtering semantics as the real query: WHERE member_id = $1
    listRecentPostsForMember: vi.fn(async (memberId: string, limit: number) =>
      ALL_POSTS.filter((p) => p.member_id === memberId).slice(0, limit),
    ),
  };
});

const { registerListRecentPosts } = await import("../src/tools/list-recent-posts.js");

type ToolCallback = (args: Record<string, unknown>, ctx: unknown) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

/** Minimal stand-in for McpServer that captures the registered callback. */
function captureTool(register: (server: never) => void): ToolCallback {
  let captured: ToolCallback | undefined;
  const fakeServer = {
    registerTool: (_name: string, _config: unknown, cb: ToolCallback) => {
      captured = cb;
    },
  };
  register(fakeServer as never);
  if (!captured) throw new Error("tool did not register");
  return captured;
}

function ctxFor(memberId: string, username: string) {
  return {
    http: {
      authInfo: {
        token: "igmcp_test",
        clientId: memberId,
        scopes: ["instagram:publish"],
        extra: {
          member: {
            id: memberId,
            name: username,
            igUserId: "178",
            igUsername: username,
            igAccessToken: "IGAAR_fake",
            igTokenExpiresAt: new Date(),
            refreshFailedAt: null,
            refreshError: null,
          },
        },
      },
    },
  };
}

describe("list_recent_posts member scoping", () => {
  const tool = captureTool(registerListRecentPosts);

  it("member A sees only member A's posts", async () => {
    const res = await tool({ limit: 10 }, ctxFor("member-a", "ada.builds"));
    const text = res.content[0]!.text;
    expect(text).toContain("Ada's carousel about auth");
    expect(text).toContain("Ada's single on idempotency");
    expect(text).not.toContain("Ben");
  });

  it("member B sees only member B's posts", async () => {
    const res = await tool({ limit: 10 }, ctxFor("member-b", "ben.ships"));
    const text = res.content[0]!.text;
    expect(text).toContain("Ben's post about billing");
    expect(text).not.toContain("Ada");
  });

  it("an unauthenticated context fails closed instead of listing anything", async () => {
    const res = await tool({ limit: 10 }, { http: {} });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/Not authenticated/);
  });
});
