import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { publishWithIdempotency } from "../instagram.js";
import { errorResult, memberFromCtx, textResult } from "./helpers.js";

const imageUrl = z
  .string()
  .url()
  .refine((u) => u.startsWith("https://") || u.startsWith("http://"), {
    message: "Image URLs must be http(s) URLs that Instagram can fetch publicly.",
  });

export function registerPublishCarousel(server: McpServer): void {
  server.registerTool(
    "publish_carousel",
    {
      title: "Publish a carousel to Instagram",
      description:
        "Publish a multi-image carousel to the calling member's own Instagram account — the account " +
        "is determined by who is calling, never by a parameter. Provide 2 to 10 public image URLs " +
        "(from upload_media) in the order the slides should appear, plus one caption; captions on " +
        "individual slides do not exist, the caption belongs to the whole post. Keep all slides the " +
        "same aspect ratio — Instagram crops every slide to match the first one. This call is " +
        "idempotent: retrying after a failure resumes where it left off instead of double-posting, " +
        "so if it fails with a transient error, calling it again with identical inputs is safe.",
      inputSchema: z.object({
        image_urls: z
          .array(imageUrl)
          .min(2, "A carousel needs at least 2 images (use publish_single for one image).")
          .max(10, "Instagram carousels cap at 10 images.")
          .describe("Public URLs of the slides, in display order (2–10)"),
        caption: z
          .string()
          .max(2200, "Instagram captions cap at 2,200 characters.")
          .describe("Caption for the whole post (hashtags included). Max 2,200 characters."),
      }),
    },
    async ({ image_urls, caption }, ctx) => {
      try {
        const member = memberFromCtx(ctx);
        const result = await publishWithIdempotency(member, image_urls, caption);
        const head = result.alreadyPublished
          ? `This exact carousel was already published to @${member.igUsername} — returning the existing post, nothing was duplicated.`
          : `Published a ${image_urls.length}-slide carousel to @${member.igUsername}.`;
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
