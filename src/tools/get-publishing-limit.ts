import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getPublishingLimit } from "../instagram.js";
import { errorResult, memberFromCtx, textResult } from "./helpers.js";

export function registerGetPublishingLimit(server: McpServer): void {
  server.registerTool(
    "get_publishing_limit",
    {
      title: "Check remaining publish quota",
      description:
        "Check how many more posts the calling member's Instagram account can publish in the current " +
        "rolling 24-hour window (Instagram caps API publishing at 100 per account per day). Worth a " +
        "quick call before a big batch of posts; not needed before every single publish.",
      inputSchema: z.object({}),
    },
    async (_args, ctx) => {
      try {
        const member = memberFromCtx(ctx);
        const { used, cap, remaining } = await getPublishingLimit(member);
        return textResult(
          `@${member.igUsername}: ${remaining} of ${cap} publishes remaining in the rolling 24-hour window (${used} used).`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
