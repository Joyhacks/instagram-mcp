import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { uploadMedia } from "../storage.js";
import { errorResult, memberFromCtx, textResult } from "./helpers.js";

export function registerUploadMedia(server: McpServer): void {
  server.registerTool(
    "upload_media",
    {
      title: "Upload an image for publishing",
      description:
        "Upload one image (PNG or JPEG, base64-encoded, up to 8 MB) and get back a public URL. " +
        "Instagram can only fetch media from a public URL, so every slide you generate has to go " +
        "through here before you can publish it. Call this once per slide, collect the URLs in " +
        "slide order, then pass them to publish_carousel or publish_single. Files land under the " +
        "calling member's own storage prefix; there is no way to write into a teammate's space.",
      inputSchema: z.object({
        filename: z
          .string()
          .min(1)
          .max(200)
          .describe("Original filename including extension, e.g. slide-01.png"),
        data_base64: z.string().min(1).describe("The file bytes, base64-encoded (no data: prefix)"),
      }),
    },
    async ({ filename, data_base64 }, ctx) => {
      try {
        const member = memberFromCtx(ctx);
        const result = await uploadMedia(member.id, filename, data_base64);
        return textResult(
          `Uploaded ${filename} (${(result.bytes / 1024).toFixed(0)} KB, ${result.contentType}).\n` +
            `Public URL: ${result.url}\n` +
            `Use this URL in publish_carousel or publish_single.`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
