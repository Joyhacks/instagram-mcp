import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { publishWithIdempotency } from "../instagram.js";
import { errorResult, memberFromCtx, textResult } from "./helpers.js";

export function registerPublishSingle(server: McpServer): void {
  server.registerTool(
    "publish_single",
    {
      title: "Publish a single image to Instagram",
      description:
        "Publish one image to the calling member's own Instagram account — the account is determined " +
        "by who is calling, never by a parameter. Provide one public image URL (from upload_media) " +
        "and a caption. For two or more images use publish_carousel instead. Idempotent like " +
        "publish_carousel: retrying an identical failed call resumes safely instead of double-posting.",
      inputSchema: z.object({
        image_url: z
          .string()
          .url()
          .describe("Public URL of the image (JPEG or PNG), from upload_media"),
        caption: z
          .string()
          .max(2200, "Instagram captions cap at 2,200 characters.")
          .describe("Caption for the post (hashtags included). Max 2,200 characters."),
      }),
    },
    async ({ image_url, caption }, ctx) => {
      try {
        const member = memberFromCtx(ctx);
        const result = await publishWithIdempotency(member, [image_url], caption);
        const head = result.alreadyPublished
          ? `This exact post was already published to @${member.igUsername} — returning the existing post, nothing was duplicated.`
          : `Published to @${member.igUsername}.`;
        return textResult(
          `${head}\n` +
            `media_id: ${result.mediaId}\n` +
            `permalink: ${result.permalink ?? "(not available yet — check the account feed)"}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
