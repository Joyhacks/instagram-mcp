import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { listRecentPostsForMember } from "../db.js";
import { errorResult, memberFromCtx, textResult } from "./helpers.js";

export function registerListRecentPosts(server: McpServer): void {
  server.registerTool(
    "list_recent_posts",
    {
      title: "List the caller's recent posts",
      description:
        "List the calling member's own recent posts from this server's publish log — never a " +
        "teammate's. Shows status (pending / published / failed), caption, permalink, and the error " +
        "message for failures. Use it to confirm whether a publish landed before retrying, or to " +
        "grab the permalink of something published earlier.",
      inputSchema: z.object({
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe("How many posts to return, newest first (default 10, max 50)"),
      }),
    },
    async ({ limit }, ctx) => {
      try {
        const member = memberFromCtx(ctx);
        const posts = await listRecentPostsForMember(member.id, limit ?? 10);
        if (posts.length === 0) {
          return textResult(`No posts logged yet for @${member.igUsername}.`);
        }
        const lines = posts.map((p) => {
          const when = p.created_at.slice(0, 16).replace("T", " ");
          const caption = (p.caption ?? "").replace(/\s+/g, " ").slice(0, 60);
          const tail =
            p.status === "published"
              ? (p.permalink ?? p.ig_media_id ?? "")
              : p.status === "failed"
                ? `error: ${(p.error ?? "unknown").slice(0, 120)}`
                : "in progress";
          const count = p.image_urls?.length ?? 0;
          const kind = count > 1 ? `carousel×${count}` : "single";
          return `• [${p.status}] ${when} UTC —  ${kind} —  "${caption}${caption.length === 60 ? "…" : ""}" ℔  ${tail}`;
        });
        return textResult(`Recent posts for @${member.igUsername}:\n${lines.join("\n")}`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
