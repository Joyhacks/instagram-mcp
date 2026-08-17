import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireEnv } from "./env.js";

/**
 * Supabase access via the service role key. RLS is enabled on both tables with
 * no policies, so this service client is the only thing that can touch them.
 */

export interface TeamMemberRow {
  id: string;
  name: string;
  token_hash: string;
  ig_user_id: string;
  ig_username: string;
  ig_access_token_encrypted: string;
  ig_token_expires_at: string;
  revoked_at: string | null;
  refresh_failed_at: string | null;
  refresh_error: string | null;
  created_at: string;
}

export interface PostRow {
  id: string;
  member_id: string;
  ig_media_id: string | null;
  permalink: string | null;
  caption: string | null;
  image_urls: string[] | null;
  idempotency_key: string | null;
  status: "pending" | "published" | "failed";
  container_ids: string[] | null;
  parent_container_id: string | null;
  error: string | null;
  created_at: string;
}

let client: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (!client) {
    client = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_KEY"), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

/** Test seam: replace the client (vitest) without reaching for module mocks everywhere. */
export function __setDbClientForTests(fake: SupabaseClient | null): void {
  client = fake;
}

function throwIfError<T>(result: { data: T; error: { message: string } | null }, what: string): T {
  if (result.error) {
    throw new Error(`Database error while ${what}: ${result.error.message}`);
  }
  return result.data;
}

// --- team_members -------------------------------------------------------------

export async function findMemberByTokenHash(tokenHash: string): Promise<TeamMemberRow | null> {
  const { data, error } = await db()
    .from("team_members")
    .select("*")
    .eq("token_hash", tokenHash)
    .maybeSingle();
  if (error) throw new Error(`Database error while looking up member: ${error.message}`);
  return (data as TeamMemberRow | null) ?? null;
}

export async function listActiveMembers(): Promise<TeamMemberRow[]> {
  const { data, error } = await db()
    .from("team_members")
    .select("*")
    .is("revoked_at", null)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Database error while listing members: ${error.message}`);
  return (data as TeamMemberRow[]) ?? [];
}

export async function updateMemberIgToken(
  memberId: string,
  encryptedToken: string,
  expiresAt: Date,
): Promise<void> {
  const result = await db()
    .from("team_members")
    .update({
      ig_access_token_encrypted: encryptedToken,
      ig_token_expires_at: expiresAt.toISOString(),
      refresh_failed_at: null,
      refresh_error: null,
    })
    .eq("id", memberId);
  throwIfError(result, "updating member token");
}

export async function markMemberRefreshFailed(memberId: string, message: string): Promise<void> {
  const result = await db()
    .from("team_members")
    .update({ refresh_failed_at: new Date().toISOString(), refresh_error: message.slice(0, 1000) })
    .eq("id", memberId);
  throwIfError(result, "marking member refresh failure");
}

export async function insertMember(row: {
  name: string;
  token_hash: string;
  ig_user_id: string;
  ig_username: string;
  ig_access_token_encrypted: string;
  ig_token_expires_at: string;
}): Promise<TeamMemberRow> {
  const { data, error } = await db().from("team_members").insert(row).select().single();
  if (error) throw new Error(`Database error while inserting member: ${error.message}`);
  return data as TeamMemberRow;
}

// --- posts --------------------------------------------------------------------

export async function findPostByIdempotencyKey(key: string): Promise<PostRow | null> {
  const { data, error } = await db()
    .from("posts")
    .select("*")
    .eq("idempotency_key", key)
    .maybeSingle();
  if (error) throw new Error(`Database error while looking up post: ${error.message}`);
  return (data as PostRow | null) ?? null;
}

/**
 * Insert the pending post row BEFORE any Meta call. If the idempotency key
 * already exists (unique violation — e.g. a racing retry), returns the
 * existing row instead of throwing.
 */
export async function insertPendingPost(row: {
  member_id: string;
  caption: string;
  image_urls: string[];
  idempotency_key: string;
}): Promise<{ post: PostRow; created: boolean }> {
  const { data, error } = await db()
    .from("posts")
    .insert({ ...row, status: "pending" })
    .select()
    .single();
  if (!error) return { post: data as PostRow, created: true };
  // 23505 = unique_violation on idempotency_key: another run got there first.
  if (error.code === "23505") {
    const existing = await findPostByIdempotencyKey(row.idempotency_key);
    if (existing) return { post: existing, created: false };
  }
  throw new Error(`Database error while creating post record: ${error.message}`);
}

export async function updatePost(
  postId: string,
  patch: Partial<
    Pick<
      PostRow,
      "ig_media_id" | "permalink" | "status" | "container_ids" | "parent_container_id" | "error"
    >
  >,
): Promise<void> {
  const result = await db().from("posts").update(patch).eq("id", postId);
  throwIfError(result, "updating post record");
}

export async function listRecentPostsForMember(memberId: string, limit: number): Promise<PostRow[]> {
  const { data, error } = await db()
    .from("posts")
    .select("*")
    .eq("member_id", memberId) // scoping: only ever the calling member's rows
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Database error while listing posts: ${error.message}`);
  return (data as PostRow[]) ?? [];
}
