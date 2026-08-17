import type { AuthInfo } from "@modelcontextprotocol/server";
import { requireMember, type CallingMember } from "../auth.js";

/**
 * Tool callbacks receive the transport context; the validated bearer token's
 * AuthInfo rides on ctx.http.authInfo. This is the single seam every tool uses
 * to resolve "who is calling" — never a tool parameter.
 */
export interface ToolCtxLike {
  http?: { authInfo?: AuthInfo };
}

export function memberFromCtx(ctx: ToolCtxLike): CallingMember {
  return requireMember(ctx.http?.authInfo);
}

export function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/** Tools return readable failure messages, never raw API JSON. */
export function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: message }], isError: true };
}
