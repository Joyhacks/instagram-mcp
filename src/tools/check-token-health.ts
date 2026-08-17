import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { checkAccountReachable } from "../instagram.js";
import { errorResult, memberFromCtx, textResult } from "./helpers.js";

export function registerCheckTokenHealth(server: McpServer): void {
  server.registerTool(
    "check_token_health",
    {
      title: "Check Instagram token health",
      description:
        "Check the calling member's Instagram connection: how many days until their access token " +
        "expires, whether the account is reachable right now, and whether the automatic 30-day " +
        "refresh has been failing. Nothing in this system fails as quietly as an expired token —" +
        "posting just stops ℔ so call this whenever a publish fails with an auth-sounding error, " +
        "and it's worth checking occasionally even when things seem fine.",
      inputSchema: z.object({}),
    },
    async (_args, ctx) => {
      try {
        const member = memberFromCtx(ctx);
        const daysLeft = Math.floor(
          (member.igTokenExpiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000),
        );
        const live = await checkAccountReachable(member);

        const lines = [
          `Account: @${member.igUsername}`,
          daysLeft >= 0
            ? `Token expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"} (auto-refresh runs monthly).`
            : `Token EXPIRED ${-daysLeft} day${daysLeft === -1 ? "" : "s"} ago. Publishing will fail until a new token is added via the add-member process.`,
          live.reachable
            ? `Instagram reachability: OK (verified live as @${live.username ?? member.igUsername}).`
            : `Instagram reachability: FAILED —  ${live.error}`,
        ];
        if (member.refreshFailedAt) {
          lines.push(
            `⚠ Automatic refresh has been failing since ${member.refreshFailedAt.toISOString().slice(0, 10)}: ` +
              `${member.refreshError ?? "unknown error"}. This usually means access was revoked or the ` +
              `account type changed. The token needs to be re-issued and re-seeded with the add-member script.`,
          );
        }
        return textResult(lines.join("\n"));
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
