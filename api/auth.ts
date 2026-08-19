/**
 * Instagram Login OAuth helper — DEMO / ADMIN USE ONLY.
 *
 * GET /api/auth          → redirects to Instagram OAuth consent screen
 * GET /api/auth/callback → exchanges the code, shows the long-lived token
 *
 * Protected by CRON_SECRET so only the admin can start a flow.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";

const APP_ID = process.env.IG_APP_ID!;
const APP_SECRET = process.env.IG_APP_SECRET!;
// Use the stable production URL, not the deployment-specific VERCEL_URL
const BASE_URL = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  : "https://instagram-mcp-nu.vercel.app";
const REDIRECT_URI = `${BASE_URL}/api/auth/callback`;

const SCOPES = [
  "instagram_business_basic",
  "instagram_business_content_publish",
].join(",");

export default async function handler(req: VercelRequest, res: VercelResponse) {
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
