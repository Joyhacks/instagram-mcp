import { encryptToken, decryptToken } from "./crypto.js";
import {
  listActiveMembers,
  markMemberRefreshFailed,
  updateMemberIgToken,
} from "./db.js";
import { IgApiError, refreshLongLivedToken } from "./instagram.js";

/**
 * Refresh every non-revoked member's long-lived Instagram token (60-day
 * lifetime). Run DAILY by Vercel cron, but only actually refresh a token once
 * it enters the renewal window (≤ REFRESH_WHEN_DAYS_LEFT to expiry). Running
 * daily instead of monthly means a token that's approaching expiry gets a fresh
 * retry every 24 hours: a single failed run no longer leaves it one attempt
 * from expiring. The window is wide enough (25 days) that it takes 25
 * consecutive failed days to actually lose a token — by which point
 * check_token_health has been shouting for weeks.
 *
 * Design rules, deliberately:
 *  - One member failing must not abort the loop. Every member is attempted.
 *  - Permanent failures (revoked access, changed account type → error 190) are
 *    marked on the row and surfaced through check_token_health, not retried
 *    forever as if they might heal.
 *  - Nothing here fails as quietly as an expired token, so the summary names
 *    names instead of hiding behind a count.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Long-lived tokens last 60 days and must be at least 24h old to refresh. */
const TOKEN_LIFETIME_DAYS = 60;
/**
 * Start refreshing a token once it has this many days (or fewer) left. At 25,
 * a 60-day token first refreshes around day 35, then every ~35 days after,
 * and always has a 25-day daily-retry runway before it could expire.
 */
const REFRESH_WHEN_DAYS_LEFT = 25;

export interface RefreshReport {
  refreshed: string[];
  /** Not yet in the renewal window — plenty of runway, nothing to do. */
  skippedNotDue: string[];
  /** In the window but <24h old, which Meta refuses to refresh. Rare. */
  skippedTooFresh: string[];
  failedPermanent: Array<{ name: string; error: string }>;
  failedTransient: Array<{ name: string; error: string }>;
}

export async function refreshAllTokens(): Promise<RefreshReport> {
  const report: RefreshReport = {
    refreshed: [],
    skippedNotDue: [],
    skippedTooFresh: [],
    failedPermanent: [],
    failedTransient: [],
  };

  const members = await listActiveMembers();

  for (const row of members) {
    const label = `${row.name} (@${row.ig_username})`;
    try {
      const expiresAt = new Date(row.ig_token_expires_at).getTime();
      const daysLeft = (expiresAt - Date.now()) / DAY_MS;

      // Not in the renewal window yet — leave it alone. This is what makes a
      // daily cron cheap: most days, most tokens do nothing.
      if (daysLeft > REFRESH_WHEN_DAYS_LEFT) {
        report.skippedNotDue.push(label);
        continue;
      }

      // Issued ≈ expires_at − 60 days. Meta refuses to refresh tokens younger
      // than 24 hours. A token in the renewal window is ~35 days old so this is
      // effectively unreachable, but it guards unusual lifetimes and re-seeds.
      const approxAgeMs = TOKEN_LIFETIME_DAYS * DAY_MS - (expiresAt - Date.now());
      if (approxAgeMs < DAY_MS) {
        report.skippedTooFresh.push(label);
        continue;
      }

      const currentToken = decryptToken(row.ig_access_token_encrypted);
      const { accessToken, expiresAt: newExpiry } = await refreshLongLivedToken(currentToken);
      await updateMemberIgToken(row.id, encryptToken(accessToken), newExpiry);
      report.refreshed.push(label);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const permanent = err instanceof IgApiError && !err.isTransient;
      if (permanent) {
        // Revoked access / account type change: will never succeed again with
        // this token. Mark the row so check_token_health surfaces it.
        await markMemberRefreshFailed(row.id, message).catch(() => {});
        report.failedPermanent.push({ name: label, error: message });
      } else {
        report.failedTransient.push({ name: label, error: message });
      }
      // continue — the next member still gets refreshed
    }
  }

  return report;
}

export function formatRefreshReport(report: RefreshReport): string {
  const lines: string[] = [];
  lines.push(`Refreshed: ${report.refreshed.length ? report.refreshed.join(", ") : "none"}`);
  if (report.skippedNotDue.length) {
    lines.push(`Not due yet (>${REFRESH_WHEN_DAYS_LEFT}d runway): ${report.skippedNotDue.length} member(s).`);
  }
  if (report.skippedTooFresh.length) {
    lines.push(`Skipped (token <24h old): ${report.skippedTooFresh.join(", ")}`);
  }
  for (const f of report.failedPermanent) {
    lines.push(`PERMANENT FAILURE — ${f.name}: ${f.error} → marked; needs re-onboarding via add-member.`);
  }
  for (const f of report.failedTransient) {
    lines.push(`Transient failure — ${f.name}: ${f.error} → will retry on the next cron run.`);
  }
  return lines.join("\n");
}
