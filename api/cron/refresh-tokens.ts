import { timingSafeEqual } from "node:crypto";
import { formatRefreshReport, refreshAllTokens } from "../../src/refresh.js";

/**
 * Vercel Cron target (monthly — see vercel.json). Vercel calls this path with
 * "Authorization: Bearer <CRON_SECRET>" when CRON_SECRET is set in the project
 * env. Anyone without that secret gets a 401.
 */

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // fail closed if the secret was never configured
  const header = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function handle(req: Request): Promise<Response> {
  if (!authorized(req)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const report = await refreshAllTokens();
  const body = formatRefreshReport(report);
  console.log(`[cron:refresh-tokens]\n${body}`);
  const hasFailures = report.failedPermanent.length > 0 || report.failedTransient.length > 0;
  // Non-200 on failure makes the cron run show as errored in the Vercel
  // dashboard instead of silently green.
  return new Response(body, { status: hasFailures ? 500 : 200 });
}

export { handle as GET, handle as POST };
