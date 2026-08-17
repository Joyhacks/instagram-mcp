import type { AuthInfo } from "@modelcontextprotocol/server";
import { decryptToken, hashBearerToken, timingSafeEqualHex } from "./crypto.js";
import { findMemberByTokenHash, type TeamMemberRow } from "./db.js";

/**
 * Bearer auth. The token identifies the person; the person maps to exactly one
 * Instagram account. This module is the ONLY place a request is associated
 * with an Instagram account — tools never accept an account id as input.
 */

export interface CallingMember {
  /** team_members.id */
  id: string;
  name: string;
  igUserId: string;
  igUsername: string;
  /** Decrypted Instagram access token — server-side only, never returned by tools. */
  igAccessToken: string;
  igTokenExpiresAt: Date;
  refreshFailedAt: Date | null;
  refreshError: string | null;
}

function toCallingMember(row: TeamMemberRow): CallingMember {
  return {
    id: row.id,
    name: row.name,
    igUserId: row.ig_user_id,
    igUsername: row.ig_username,
    igAccessToken: decryptToken(row.ig_access_token_encrypted),
    igTokenExpiresAt: new Date(row.ig_token_expires_at),
    refreshFailedAt: row.refresh_failed_at ? new Date(row.refresh_failed_at) : null,
    refreshError: row.refresh_error,
  };
}

/**
 * Resolve a presented bearer token to a member, or null (which the transport
 * layer turns into a 401 before any tool logic runs).
 *
 * - Presented token is hashed; the raw token is never stored or logged.
 * - Lookup is by hash equality, then re-verified with a constant-time
 *   comparison (never ===) as defense in depth.
 * - A revoked member (revoked_at set) is indistinguishable from an unknown
 *   token: both are null → 401.
 */
export async function resolveMemberFromToken(
  bearerToken: string | undefined | null,
): Promise<CallingMember | null> {
  if (!bearerToken || bearerToken.length < 16 || bearerToken.length > 512) return null;
  const presentedHash = hashBearerToken(bearerToken);
  const row = await findMemberByTokenHash(presentedHash);
  if (!row) return null;
  if (!timingSafeEqualHex(presentedHash, row.token_hash)) return null;
  if (row.revoked_at) return null;
  return toCallingMember(row);
}

/**
 * verifyToken for mcp-handler's withMcpAuth. Returning undefined yields a 401
 * before any request processing. The resolved member rides in
 * AuthInfo.extra.member and is read back by every tool via requireMember().
 */
export async function verifyBearerToken(
  _req: Request,
  bearerToken?: string,
): Promise<AuthInfo | undefined> {
  const member = await resolveMemberFromToken(bearerToken);
  if (!member) return undefined;
  return {
    token: bearerToken as string,
    clientId: member.id,
    scopes: ["instagram:publish"],
    extra: { member },
  };
}

/**
 * Every tool resolves the calling member through this. If auth info is somehow
 * absent (it cannot be, with withMcpAuth required:true, but belt and braces),
 * the tool fails closed.
 */
export function requireMember(authInfo: AuthInfo | undefined): CallingMember {
  const member = authInfo?.extra?.["member"] as CallingMember | undefined;
  if (!member) {
    throw new Error("Not authenticated. This request carried no valid team member token.");
  }
  return member;
}
