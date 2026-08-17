import { createHash } from "node:crypto";
import type { CallingMember } from "./auth.js";
import {
  findPostByIdempotencyKey,
  insertPendingPost,
  updatePost,
  type PostRow,
} from "./db.js";

/**
 * Instagram Graph API client for the "Instagram API with Instagram Login" path.
 *
 * HOST MATTERS: this is graph.instagram.com, NOT graph.facebook.com. The
 * facebook.com host belongs to the Facebook Login path and fails with a
 * confusing "Cannot parse access token" error when handed an Instagram Login
 * token. Most tutorials online get this wrong.
 */
export const IG_GRAPH_HOST = "https://graph.instagram.com";
export const IG_API_VERSION = process.env.IG_API_VERSION?.trim() || "v25.0";

// ---------------------------------------------------------------------------
// Error model
// ---------------------------------------------------------------------------

export class IgApiError extends Error {
  constructor(
    message: string,
    public readonly code: number | undefined,
    public readonly subcode: number | undefined,
    public readonly httpStatus: number,
    public readonly fbtraceId?: string,
  ) {
    super(message);
    this.name = "IgApiError";
  }

  /**
   * Transient errors are worth backing off and retrying; permanent ones are
   * not. Meta error codes: 1/2 = temporary server issues, 4/17/32/613 = rate
   * limits (media_publish is rate limited), 190 = token invalid (permanent),
   * 9007 = media not ready yet.
   */
  get isTransient(): boolean {
    if (this.httpStatus >= 500) return true;
    return [1, 2, 4, 17, 32, 613].includes(this.code ?? -1);
  }

  get isAuthError(): boolean {
    return this.code === 190 || this.httpStatus === 401;
  }
}

interface IgErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    error_user_msg?: string;
    fbtrace_id?: string;
  };
}

async function igFetch<T>(
  path: string,
  options: {
    method?: "GET" | "POST";
    accessToken: string;
    params?: Record<string, string>;
    unversioned?: boolean;
  },
): Promise<T> {
  const { method = "GET", accessToken, params = {}, unversioned = false } = options;
  const base = unversioned ? IG_GRAPH_HOST : `${IG_GRAPH_HOST}/${IG_API_VERSION}`;
  const url = new URL(`${base}/${path.replace(/^\//, "")}`);

  let init: RequestInit;
  if (method === "GET") {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("access_token", accessToken);
    init = { method };
  } else {
    const body = new URLSearchParams({ ...params, access_token: accessToken });
    init = { method, body };
  }

  const res = await fetch(url, init);
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new IgApiError(
      `Instagram returned a non-JSON response (HTTP ${res.status}).`,
      undefined,
      undefined,
      res.status,
    );
  }

  if (!res.ok) {
    const err = (json as IgErrorBody).error ?? {};
    // Log the subcode — an ERROR is not just an ERROR. (Raw JSON stays out of
    // tool responses; this log line is for the operator.)
    console.error(
      `[instagram] API error: code=${err.code} subcode=${err.error_subcode} ` +
        `type=${err.type} fbtrace=${err.fbtrace_id} msg=${err.message}`,
    );
    throw new IgApiError(
      err.error_user_msg || err.message || `Instagram API error (HTTP ${res.status})`,
      err.code,
      err.error_subcode,
      res.status,
      err.fbtrace_id,
    );
  }
  return json as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Injectable clock/sleep so the retry logic is unit-testable without real delays.
let sleepImpl = sleep;
export function __setSleepForTests(fn: typeof sleep | null): void {
  sleepImpl = fn ?? sleep;
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

export async function createCarouselItemContainer(
  member: CallingMember,
  imageUrl: string,
): Promise<string> {
  const res = await igFetch<{ id: string }>(`${member.igUserId}/media`, {
    method: "POST",
    accessToken: member.igAccessToken,
    params: { image_url: imageUrl, is_carousel_item: "true" },
  });
  return res.id;
}

export async function createSingleImageContainer(
  member: CallingMember,
  imageUrl: string,
  caption: string,
): Promise<string> {
  const res = await igFetch<{ id: string }>(`${member.igUserId}/media`, {
    method: "POST",
    accessToken: member.igAccessToken,
    params: { image_url: imageUrl, caption },
  });
  return res.id;
}

export async function createCarouselParentContainer(
  member: CallingMember,
  childIds: string[],
  caption: string,
): Promise<string> {
  const res = await igFetch<{ id: string }>(`${member.igUserId}/media`, {
    method: "POST",
    accessToken: member.igAccessToken,
    params: {
      media_type: "CAROUSEL",
      // Comma-separated string, NOT a JSON array — the API rejects the array form.
      children: childIds.join(","),
      // Caption lives on the parent only; captions on children are ignored.
      caption,
    },
  });
  return res.id;
}

export type ContainerStatus = "FINISHED" | "IN_PROGRESS" | "ERROR" | "EXPIRED" | "PUBLISHED";

export async function getContainerStatus(
  member: CallingMember,
  containerId: string,
): Promise<{ status: ContainerStatus; detail?: string }> {
  // `status` alongside `status_code` carries the human-readable error detail
  // (including subcode context) when status_code is ERROR.
  const res = await igFetch<{ status_code: ContainerStatus; status?: string }>(containerId, {
    accessToken: member.igAccessToken,
    params: { fields: "status_code,status" },
  });
  return { status: res.status_code, detail: res.status };
}

/**
 * Poll a container until FINISHED. Images are usually fast, but publishing an
 * IN_PROGRESS container fails, so we always poll. ERROR and EXPIRED throw with
 * the API's detail string so the operator sees the subcode context.
 */
export async function waitForContainer(
  member: CallingMember,
  containerId: string,
  { timeoutMs = 120_000, intervalMs = 2_000 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { status, detail } = await getContainerStatus(member, containerId);
    if (status === "FINISHED" || status === "PUBLISHED") return;
    if (status === "ERROR") {
      throw new ContainerFailedError(
        containerId,
        `Instagram could not process container ${containerId}: ${detail ?? "no detail provided"}. ` +
          `Common causes: the image URL is not publicly reachable, or the file is not JPEG/PNG.`,
      );
    }
    if (status === "EXPIRED") {
      throw new ContainerExpiredError(containerId);
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Container ${containerId} is still ${status} after ${Math.round(timeoutMs / 1000)}s. ` +
          `Try the same publish call again in a minute — finished work will be reused, not redone.`,
      );
    }
    await sleepImpl(intervalMs);
  }
}

export class ContainerExpiredError extends Error {
  constructor(public readonly containerId: string) {
    super(`Container ${containerId} expired (containers live ~24 hours). It will be recreated.`);
    this.name = "ContainerExpiredError";
  }
}

export class ContainerFailedError extends Error {
  constructor(
    public readonly containerId: string,
    message: string,
  ) {
    super(message);
    this.name = "ContainerFailedError";
  }
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

/**
 * media_publish, with backoff on transient errors.
 *
 * THE RETRY DISTINCTION, explicitly: retrying media_publish with the SAME
 * creation_id is safe — Instagram will not double-publish one container.
 * Re-running the whole container-creation flow is NOT safe; that is what
 * duplicates posts and orphans containers. So this function may retry itself,
 * while the orchestrator above it never recreates containers that already
 * exist — it resumes from persisted state instead.
 */
export async function publishContainer(
  member: CallingMember,
  creationId: string,
  { maxAttempts = 5 }: { maxAttempts?: number } = {},
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await igFetch<{ id: string }>(`${member.igUserId}/media_publish`, {
        method: "POST",
        accessToken: member.igAccessToken,
        params: { creation_id: creationId },
      });
      return res.id;
    } catch (err) {
      lastError = err;
      const transient = err instanceof IgApiError && err.isTransient;
      if (!transient || attempt === maxAttempts) throw err;
      await sleepImpl(2000 * 2 ** (attempt - 1)); // 2s, 4s, 8s, 16s
    }
  }
  throw lastError as Error;
}

export async function fetchPermalink(member: CallingMember, mediaId: string): Promise<string | null> {
  try {
    const res = await igFetch<{ permalink?: string }>(mediaId, {
      accessToken: member.igAccessToken,
      params: { fields: "permalink" },
    });
    return res.permalink ?? null;
  } catch {
    // A missing permalink should never fail a publish that already succeeded.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Account / limits / token
// ---------------------------------------------------------------------------

export const PUBLISH_CAP_PER_24H = 100;

export async function getPublishingLimit(
  member: CallingMember,
): Promise<{ used: number; cap: number; remaining: number }> {
  const res = await igFetch<{ data?: Array<{ quota_usage?: number; config?: { quota_total?: number } }> }>(
    `${member.igUserId}/content_publishing_limit`,
    {
      accessToken: member.igAccessToken,
      params: { fields: "quota_usage,config" },
    },
  );
  const entry = res.data?.[0];
  const used = entry?.quota_usage ?? 0;
  const cap = entry?.config?.quota_total ?? PUBLISH_CAP_PER_24H;
  return { used, cap, remaining: Math.max(0, cap - used) };
}

export async function checkAccountReachable(
  member: CallingMember,
): Promise<{ reachable: boolean; username?: string; error?: string }> {
  try {
    const res = await igFetch<{ id?: string; user_id?: string; username?: string }>("me", {
      accessToken: member.igAccessToken,
      params: { fields: "user_id,username" },
    });
    return { reachable: true, username: res.username };
  } catch (err) {
    return { reachable: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Refresh a long-lived Instagram Login token (60-day lifetime). The token must
 * be at least 24 hours old and unexpired. Endpoint per Meta's Instagram
 * Platform reference — unversioned path on graph.instagram.com:
 *   GET /refresh_access_token?grant_type=ig_refresh_token&access_token=...
 */
export async function refreshLongLivedToken(
  currentToken: string,
): Promise<{ accessToken: string; expiresAt: Date }> {
  const res = await igFetch<{ access_token: string; token_type: string; expires_in: number }>(
    "refresh_access_token",
    {
      accessToken: currentToken,
      params: { grant_type: "ig_refresh_token" },
      unversioned: true,
    },
  );
  return {
    accessToken: res.access_token,
    expiresAt: new Date(Date.now() + res.expires_in * 1000),
  };
}

// ---------------------------------------------------------------------------
// Orchestration with idempotency
// ---------------------------------------------------------------------------

export interface PublishResult {
  mediaId: string;
  permalink: string | null;
  alreadyPublished: boolean;
  postId: string;
}

/**
 * Idempotency key: member + ordered image URL set + caption. Same slides, same
 * caption, same person → same post. Stored on the posts row BEFORE any Meta
 * call so a crash at any point leaves a resumable record.
 */
export function deriveIdempotencyKey(
  memberId: string,
  imageUrls: string[],
  caption: string,
): string {
  return createHash("sha256")
    .update([memberId, ...imageUrls, "\u0000caption:", caption].join("\n"), "utf8")
    .digest("hex");
}

const PENDING_GRACE_MS = 3 * 60 * 1000;

/**
 * Publish a single image or a carousel with resume-on-retry semantics.
 *
 * The expensive failure this guards against: four children created, parent
 * fails, retry runs from the top → duplicate post plus orphaned containers
 * eating the ~50 pending-container ceiling. Instead:
 *
 *  - container ids are persisted the moment they are created
 *  - a retry reuses FINISHED children and only recreates EXPIRED/ERROR ones
 *  - the parent id is persisted separately; retrying media_publish with the
 *    same parent id is safe (see publishContainer)
 */
export async function publishWithIdempotency(
  member: CallingMember,
  imageUrls: string[],
  caption: string,
): Promise<PublishResult> {
  const key = deriveIdempotencyKey(member.id, imageUrls, caption);

  const { post, created } = await insertPendingPost({
    member_id: member.id,
    caption,
    image_urls: imageUrls,
    idempotency_key: key,
  });

  if (!created) {
    if (post.status === "published" && post.ig_media_id) {
      return {
        mediaId: post.ig_media_id,
        permalink: post.permalink,
        alreadyPublished: true,
        postId: post.id,
      };
    }
    // A very recent pending row with no error yet is probably a concurrent
    // in-flight run; do not stomp on its containers.
    const ageMs = Date.now() - new Date(post.created_at).getTime();
    if (post.status === "pending" && !post.error && ageMs < PENDING_GRACE_MS) {
      throw new Error(
        "A publish for exactly this content is already in progress. " +
          "Wait a minute, then call list_recent_posts to see whether it landed before retrying.",
      );
    }
    // Otherwise: resume the failed/stale run below, reusing its containers.
  }

  try {
    const result =
      imageUrls.length === 1
        ? await runSingleFlow(member, post, imageUrls[0]!, caption)
        : await runCarouselFlow(member, post, imageUrls, caption);
    return { ...result, alreadyPublished: false, postId: post.id };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await updatePost(post.id, { status: "failed", error: message.slice(0, 2000) }).catch(() => {
      /* the original error matters more than a failed status write */
    });
    throw err;
  }
}

async function runSingleFlow(
  member: CallingMember,
  post: PostRow,
  imageUrl: string,
  caption: string,
): Promise<{ mediaId: string; permalink: string | null }> {
  let containerId = post.parent_container_id;

  if (containerId) {
    // Resume path: check the persisted container instead of recreating it.
    const { status } = await getContainerStatus(member, containerId).catch(() => ({
      status: "EXPIRED" as ContainerStatus,
    }));
    if (status === "ERROR" || status === "EXPIRED") containerId = null;
    if (status === "PUBLISHED") {
      // Published on a previous run but we crashed before recording it.
      return finalize(member, post, containerId!);
    }
  }

  if (!containerId) {
    containerId = await createSingleImageContainer(member, imageUrl, caption);
    await updatePost(post.id, { parent_container_id: containerId, status: "pending", error: null });
  }

  await waitForContainer(member, containerId);
  const mediaId = await publishContainer(member, containerId);
  return recordPublished(member, post, mediaId);
}

async function runCarouselFlow(
  member: CallingMember,
  post: PostRow,
  imageUrls: string[],
  caption: string,
): Promise<{ mediaId: string; permalink: string | null }> {
  // --- children, resumable ---------------------------------------------------
  // container_ids is index-aligned with image_urls; "" marks a slot whose
  // container has not been created yet (or was recreated after expiry).
  const children: string[] = [...(post.container_ids ?? [])];
  while (children.length < imageUrls.length) children.push("");

  const persistChildren = () =>
    updatePost(post.id, { container_ids: children, status: "pending", error: null });

  for (let i = 0; i < imageUrls.length; i++) {
    if (children[i]) continue; // reuse: this child already exists from a prior run
    children[i] = await createCarouselItemContainer(member, imageUrls[i]!);
    await persistChildren(); // persist as created, not at the end
  }

  // Poll every child to FINISHED. Recreate (once) any that expired or errored
  // since the previous run, then re-poll.
  for (let i = 0; i < children.length; i++) {
    try {
      await waitForContainer(member, children[i]!);
    } catch (err) {
      // A container that EXPBRED(previous run >24h ago) or ERRORed is dead —
      // recreate that one child ONCE and re-poll. Finished siblings are never
      // touched. If the recreated container fails too, the image itself is the
      // problem; surface a readable per-slide error.
      if (err instanceof ContainerExpiredError || err instanceof ContainerFailedError) {
        children[i] = await createCarouselItemContainer(member, imageUrls[i]!);
        await persistChildren();
        try {
          await waitForContainer(member, children[i]!);
        } catch (retryErr) {
          throw new Error(
            `Slide ${i + 1} (${imageUrls[i]}) failed twice and looks unpublishable. ` +
              `${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
          );
        }
      } else {
        throw new Error(`Slide ${i + 1} failed. ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // --- parent, resumable ------------------------------------------------------
  let parentId = post.parent_container_id;
  if (parentId) {
    const { status } = await getContainerStatus(member, parentId).catch(() => ({
      status: "EXPIRED" as ContainerStatus,
    }));
    if (status === "PUBLISHED") return finalize(member, post, parentId);
    if (status === "ERROR" || status === "EXPIRED") parentId = null;
  }
  if (!parentId) {
    parentId = await createCarouselParentContainer(member, children, caption);
    await updatePost(post.id, { parent_container_id: parentId });
  }

  await waitForContainer(member, parentId);

  // --- publish ----------------------------------------------------------------
  const mediaId = await publishContainer(member, parentId);
  return recordPublished(member, post, mediaId);
}

async function recordPublished(
  member: CallingMember,
  post: PostRow,
  mediaId: string,
): Promise<{ mediaId: string; permalink: string | null }> {
  const permalink = await fetchPermalink(member, mediaId);
  await updatePost(post.id, {
    status: "published",
    ig_media_id: mediaId,
    permalink,
    error: null,
  });
  return { mediaId, permalink };
}

/**
 * A container that reports PUBLISHED means a previous run published it but
 * crashed before writing the outcome. There is no duplicate to create — look
 * the row back up and treat it as published, keying media id off what we have.
 */
async function finalize(
  member: CallingMember,
  post: PostRow,
  _containerId: string,
): Promise<{ mediaId: string; permalink: string | null }> {
  const fresh = await findPostByIdempotencyKey(post.idempotency_key ?? "");
  if (fresh?.ig_media_id) {
    return { mediaId: fresh.ig_media_id, permalink: fresh.permalink };
  }
  // Media id was never recorded. Surface an honest state instead of guessing:
  // the post exists on Instagram; mark the row published-without-id.
  await updatePost(post.id, {
    status: "published",
    error: "Published on a previous run; media id was not captured. Check the account feed.",
  });
  return { mediaId: "unknown (published on a previous run)", permalink: null };
}
