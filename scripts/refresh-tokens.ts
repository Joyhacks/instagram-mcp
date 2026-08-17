/**
 * Manual runner for the token refresh loop — the same code the Vercel cron
 * executes. Useful right after seeding members or when a cron run reported
 * failures and you want to retry now.
 *
 *   npm run refresh-tokens
 */
import { loadEnvLocal } from "../src/env.js";

loadEnvLocal();

const { refreshAllTokens, formatRefreshReport } = await import("../src/refresh.js");

const report = await refreshAllTokens();
console.log(formatRefreshReport(report));

if (report.failedPermanent.length > 0 || report.failedTransient.length > 0) {
  process.exitCode = 1;
}
