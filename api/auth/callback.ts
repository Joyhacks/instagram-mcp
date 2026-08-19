/**
 * Instagram OAuth callback — receives the auth code and exchanges it for a
 * long-lived token which is displayed once for the admin to copy.
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";

const APP_ID = process.env.IG_APP_ID!;
const APP_SECRET = process.env.IG_APP_SECRET!;
// Use the stable production URL, not the deployment-specific VERCEL_URL
const BASE_URL = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  : "https://instagram-mcp-nu.vercel.app";
const REDIRECT_URI = `${BASE_URL}/api/auth/callback`;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { code, error, error_reason, error_description } = req.query;

  if (error) {
    return res.status(400).send(html(`
      <h2 style="color:red">OAuth Error</h2>
      <p><b>${error}</b>: ${error_description ?? error_reason ?? "unknown"}</p>
      <p>Go back and try again.</p>
    `));
  }

  if (!code || typeof code !== "string") {
    return res.status(400).send(html(`<p>Missing <code>code</code> parameter.</p>`));
  }

  // Step 1: exchange code for short-lived token
  const shortRes = await fetch("https://api.instagram.com/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: APP_ID,
      client_secret: APP_SECRET,
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
      code,
    }).toString(),
  });

  const shortBody = await shortRes.json() as {
    access_token?: string;
    user_id?: number;
    error_type?: string;
    error_message?: string;
  };

  if (!shortRes.ok || !shortBody.access_token) {
    return res.status(502).send(html(`
      <h2 style="color:red">Token Exchange Failed</h2>
      <pre>${JSON.stringify(shortBody, null, 2)}</pre>
    `));
  }

  // Step 2: exchange short-lived for long-lived token (60 days)
  const longUrl = new URL("https://graph.instagram.com/access_token");
  longUrl.searchParams.set("grant_type", "ig_exchange_token");
  longUrl.searchParams.set("client_secret", APP_SECRET);
  longUrl.searchParams.set("access_token", shortBody.access_token);

  const longRes = await fetch(longUrl.toString());
  const longBody = await longRes.json() as {
    access_token?: string;
    token_type?: string;
    expires_in?: number;
    error?: { message?: string };
  };

  if (!longRes.ok || !longBody.access_token) {
    return res.status(502).send(html(`
      <h2 style="color:red">Long-Lived Token Exchange Failed</h2>
      <pre>${JSON.stringify(longBody, null, 2)}</pre>
    `));
  }

  const expiresInDays = longBody.expires_in ? Math.floor(longBody.expires_in / 86400) : 60;
  const userId = shortBody.user_id;

  return res.send(html(`
    <h2 style="color:green">✅ Long-Lived Instagram Token Generated</h2>
    <p>This token is valid for <b>${expiresInDays} days</b>. Copy it immediately — this page won't show it again.</p>

    <h3>Instagram User ID</h3>
    <pre id="uid" style="background:#f4f4f4;padding:12px;border-radius:6px;word-break:break-all">${userId}</pre>
    <button onclick="copy('uid')">Copy User ID</button>

    <h3>Long-Lived Access Token</h3>
    <pre id="tok" style="background:#f4f4f4;padding:12px;border-radius:6px;word-break:break-all">${longBody.access_token}</pre>
    <button onclick="copy('tok')">Copy Token</button>

    <hr/>
    <p>Now run from your terminal / the MCP session:</p>
    <pre style="background:#1e1e1e;color:#d4d4d4;padding:12px;border-radius:6px">npm run add-member -- \\
  --name "Adeola Ilori" \\
  --ig-user-id ${userId} \\
  --ig-username adeola.builds</pre>
    <p>Paste the token above when prompted. The token is encrypted and stored.</p>

    <script>
      function copy(id) {
        navigator.clipboard.writeText(document.getElementById(id).textContent.trim());
        alert('Copied!');
      }
    </script>
  `));
}

function html(body: string): string {
  return `<!DOCTYPE html><html><head>
  <meta charset="utf-8"/>
  <title>Instagram MCP Auth</title>
  <style>body{font-family:system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 20px}
  pre{overflow-x:auto}button{margin-top:6px;padding:6px 14px;cursor:pointer}</style>
  </head><body>
  <h1>Instagram MCP — OAuth Helper</h1>
  ${body}
  </body></html>`;
}
