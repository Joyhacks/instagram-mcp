/**
 * Instagram Login OAuth helper — DEMO / ADMIN USE ONLY.
 *
 * GET /api/auth          → redirects to Instagram OAuth consent screen
 * GET /api/auth/callback → exchanges the code, shows the long-lived token
 *
 * This endpoint exists solely to let the admin seed team members without
 * needing a separate OAuth client. It is protected by CRON_SECRET so
 * strangers cannot initiate flows.
 *
 * Once you have copied the long-lived token, run:
 *   npm run add-member -- --name "..." --ig-user-id ... --ig-username ...
 * and paste the token when prompted.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";

const APP_ID = process.env.IG_APP_ID!;
// Hardcoded to eliminate any env-var mismatch with Meta's registered redirect URI
const REDIRECT_URI = "https://instagram-mcp-nu.vercel.app/api/auth/callback";

const SCOPES = [
  "instagram_business_basic",
  "instagram_business_content_publish",
].join(",");

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Simple guard: require ?secret=CRON_SECRET so only the admin can start a flow
  const secret = process.env.CRON_SECRET;
  if (secret && req.query.secret !== secret) {
    return res.status(401).send("Unauthorized. Add ?secret=<CRON_SECRET> to the URL.");
  }

  const authUrl = new URL("https://www.instagram.com/oauth/authorize");
  authUrl.searchParams.set("client_id", APP_ID);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("scope", SCOPES);
  authUrl.searchParams.set("response_type", "code");

  res.redirect(302, authUrl.toString());
}
