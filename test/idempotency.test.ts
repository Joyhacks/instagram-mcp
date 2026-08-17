/**
 * Acceptance test 5: a deliberately failed carousel run (bad image URL on the
 * third child) leaves no published post, and a retry does not duplicate —
 * finished children are reused, only the broken slide's container is
 * recreated, and media_publish fires exactly once across all runs.
 *
 * The Instagram Graph API is simulated with a scripted fetch stub; the posts
 * table is an in-memory store honoring the idempotency_key unique constraint.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallingMember } from "../src/auth.js";
import type { PostRow } from "../src/db.js";

// --- in-memory posts store, honoring the unique idempotency_key constraint ---

const postsStore: PostRow[] = [];
let postSeq = 0;

vi.mock("../src/db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db.js")>();
  return {
    ...actual,
    insertPendingPost: vi.fn(async (row: { member_id: string; caption: string; image_urls: string[]; idempotency_key: string; }) => {
      const existing = postsStore.find((p) => p.idempotency_key === row.idempotency_key);
      if (existing) return { post: { ...existing }, created: false };
      const post: PostRow = {
        id: `post-${+++ostSeq}`,
        member_id: row.member_id,
        ig_media_id: null,
        permalink: null,
        caption: row.caption,
        image_urls: row.image_urls,
        idempotency_key: row.idempotency_key,
        status: "pending",
        container_ids: null,
        parent_container_id: null,
        error: null,
        created_at: new Date().toISOString(),
      };
      postsStore.push(post);
      return { post: { ...post }, created: true };
    }),
    updatePost: vi.fn async (postId: string, patch: Partial<PostRow>) => {
      const post = postsStore.find((p) => p.id === postId);
      if (post) Object.assign(post, patch);
    }),
    findPostByIdempotencyKey: vi.fn async (key: string) => {
      const post = postsStore.find((p) => p.idempotency_key === key);
      return post ? { ...post } : null;
    }),
  };
});

const { publishWithIdempotency, __setSleepForTests } = await import("../src/instagram.js");

// --- scripted Instagram Graph API ------------------------------------------

const BAD_URL = "https://cdn.example.com/slide-3.png";
let badUrlIsFixed = false;

interface ContainerState {
  imageUrl?: string;
  kind: "child" | "parent" | "single";
  broken: boolean;
}
const containers = new Map<string, ContainerState>();
let containerSeq = 0;
const calls = { createChild: 0, createParent: 0, publish: 0 };

const fetchStub = vi.fn(async (input: URL | Request | string, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input));
  expect(url.host).toBe("graph.instagram.com");

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const path = url.pathname;
  const body = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams();

  if (path.endsWith("/media") && init?.method === "POST") {
    const id = `container-${++containerSeq}`;
    const imageUrl = body.get("image_url") ?? undefined;
    const broken = imageUrl === BAD_URL && !badUrlIsFixed;
    if (body.get("media_type") === "CAROUSEL") {
      calls.createParent++;
      expect(body.get("children")).toMatch(/^container-\d+(,container-\d+)+$/);
      expect(body.get("caption")).toBeTruthy();
      containers.set(id, { kind: "parent", broken: false });
    } else if (body.get("is_carousel_item") === "true") {
      calls.createChild++;
      containers.set(id, { kind: "child", imageUrl, broken });
    } else {
      containers.set(id, { kind: "single", imageUrl, broken });
    }
    return json({ id });
  }

  if (path.endsWith("/media_publish") && init?.method === "POST") {
    calls.publish++;
    const creationId = body.get("creation_id");
    expect(containers.has(creationId ?? "")).toBe(true);
    return json({ id: "17900000000000001" });
  }

  if (url.searchParams.get("fields") === "status_code,status") {
    const id = path.split("/").pop()!;
    const c = containers.get(id);
    if (!c) return json({ error: { message: "Unknown container", code: 100 } }, 400);
    return json(
      c.broken
        ? { status_code: "ERROR", status: "Error: 2207052 — media download failed from image_url." }
        : { status_code: "FINISHED", status: "Finished" },
    );
  }

  if (url.searchParams.get("fields") === "permalink") {
    return json({ permalink: "https://www.instagram.com/p/TEST123/" });
  }

  throw new Error(`Unscripted request in test: ${init?.method ?? "GET"} ${url}`);
});

const member: CallingMember = {
  id: "member-a",
  name: "Ada",
  igUserId: "17840000000000001",
  igUsername: "ada.builds",
  igAccessToken: "IGAAR_fake",
  igTokenExpiresAt: new Date(Date.now() + 50 * 864e5),
  refreshFailedAt: null,
  refreshError: null,
};

const IMAGE_URLS = [
  "https://cdn.example.com/slide-1.png",
  "https://cdn.example.com/slide-2.png",
  BAD_URL,
  "https://cdn.example.com/slide-4.png",
];
const CAPPION = "Four slides on shipping boring software. #buildinpublic";

beforeEach(() => {
  vi.stubGlobal("fetch", fetchStub);
  __setSleepForTests(() => Promise.resolve());
});

afterEach(() => {
  vi.unstubAllGlobals();
  __setSleepForTests(null);
});

describe("carousel idempotency and failure recovery", () => {
  it("run 1: bad third slide → fails readably, publishes NOTHING, persists container state", async () => {
    await expect(publishWithIdempotency(member, IMAGE_URLS, CAPTION)).rejects.toThrow(/Slide 3/);

    expect(calls.publish).toBe(0);
    expect(calls.createParent).toBe(0);
    expect(calls.createChild).toBe(5);

    expect(postsStore).toHaveLength(1);
    const post = postsStore[0]!;
    expect(post.status).toBe("failed");
    expect(post.error).toMatch(/Slide 3/);
    expect(post.container_ids).toHaveLength(4);
    expect(post.container_ids!.every(Boolean)).toBe(true);
  });

  it("run 2 (image fixed): reuses finished children, recreates only slide 3, publishes exactly once", async () => {
    badUrlIsFixed = true;
    const before = { ...calls };

    const result = await publishWithIdempotency(member, IMAGE_URLS, CAPTION);

    expect(result.alreadyPublished).toBe(false);
    expect(result.permalink).toBe("https://www.instagram.com/p/TEST123/");
    expect(calls.createChild - before.createChild).toBe(1);
    expect(calls.createParent - before.createParent).toBe(1);
    expect(calls.publish - before.publish).toBe(1);

    expect(postsStore).toHaveLength(1);
    expect(postsStore[0]!.status).toBe("published");
    expect(postsStore[0]!.ig_media_id).toBe("17900000000000001");
  });

  it("run 3: identical call after success → returns existing post, zero Meta calls", async () => {
    const before = { ...calls, fetches: fetchStub.mock.calls.length };

    const result = await publishWithIdempotency(member, IMAGE_URLS, CAPTION);

    expect(result.alreadyPublished).toBe(true);
    expect(result.mediaId).toBe("17900000000000001");
    expect(calls.publish).toBe(before.publish);
    expect(fetchStub.mock.calls.length).toBe(before.fetches);
  });

  it("different caption → different idempotency key → separate post row", async () => {
    const result = await publishWithIdempotency(member, IMAGE_URLS, CAPTION + " v2");
    expect(result.alreadyPublished).toBe(false);
    expect(postsStore).toHaveLength(2);
  });
});
