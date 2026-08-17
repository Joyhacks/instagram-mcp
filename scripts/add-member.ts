/**
 * Seed a team member. Run locally by the admin — never exposed over HTTP.
 *
 *   npm run add-member -- --name "Ada" --ig-user-id 1784... --ig-username ada.builds
 *
 * The member's long-lived Instagram token is read from stdin (prompted), so it
 * never lands in shell history or process listings. The script:
 *   1. verifies the IG token live against graph.instagram.com (skippable),
 *   2. generates the member's bearer token (printed ONCE — store it in a
 *      password manager; only its SHA-256 hash is stored),
 *   3. encrypts the IG token with AES-256-GCM and inserts the row.
 *
 * Requires MCP_ADMIN_TOKEN to be set in .env.local as a guard against running
 * it unintentionally.
 */
import { createInterface } from "node:readline";
import { loadEnvLocal, requireEnv } from "../src/env.js";

loadEnvLocal();

function arg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  const val = idx >= 0 ? process.argv[idx + 1] : undefined;
  return val && !val.startsWith("--") ? val : undefined;
}

function fail(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

// Guard: deliberate operator intent required.
if (!process.env.MCP_ADMIN_TOKEN?.trim()) {
  fail("MCP_ADMIN_TOKEN is not set in .env.local. Set it before seeding members.");
}
requireEnv("TOKEN_ENCRYPTION_KEY");
requireEnv("SUPABASE_URL");
requireEnv("SUPABASE_SERVICE_KEY");

const name = arg("--name") ?? fail("Missing --name \"Person Name\"");
const igUserId = arg("--ig-user-id") ?? fail("Missing --ig-user-id (their Instagram professional account's user id)");
const igUsername = (arg("--ig-username") ?? fail("Missing --ig-username (without @)")).replace(/^@/, "");
const expiresDays = Number(arg("--expires-days") ?? "60");
const skipVerify = process.argv.includes("--skip-verify");

if (!/^\d+$/.test(igUserId)) fail("--ig-user-id should be numeric.");
if (!Number.isFinite(expiresDays) || expiresDays < 1 || expiresDays > 60) {
  fail("--expires-days must be between 1 and 60 (long-lived tokens last 60 days).");
}

// Prompt for the IG token on stdin so it stays out of shell history.
const rl = createInterface({ input: process.stdin, output: process.stdout });
const igToken: string = await new Promise((resolve) => {
  rl.question(`Paste ${name}'s long-lived Instagram access token (input hidden from history): `, (answer) => {
    rl.close();
    resolve(answer.trim());
  });
});
if (!igToken || igToken.length < 20) fail("That does not look like an Instagram access token.");

// Live verification against the correct host (graph.instagram.com — the
// facebook.com host fails with a token parse error for Instagram Login tokens).
if (!skipVerify) {
  const { IG_GRAPH_HOST, IG_API_VERSION } = await import("../src/instagram.js");
  const url = new URL(`${IG_GRAPH_HOST}/${IG_API_VERSION}/me`);
  url.searchParams.set("fields", "user_id,username");
  url.searchParams.set("access_token", igToken);
  const res = await fetch(url);
  const body = (await res.json().catch(() => ({}))) as {
    user_id?: string;
    id?: string;
    username?: string;
    error?: { message?: string };
  };
  if (!res.ok) {
    fail(
      `Token verification failed: ${body.error?.message ?? `HTTP ${res.status}`}\n` +
        `  Checklist: is this a LONG-LIVED token from the Instagram Login flow? Is the account a\n` +
        `  professional account added as an Instagram Tester on the Meta app (invitation accepted)?`,
    );
  }
  const liveId = body.user_id ?? body.id;
  if (liveId && liveId !== igUserId) {
    fail(
      `Token belongs to user id ${liveId} (@${body.username}), but you passed --ig-user-id ${igUserId}.\n` +
        `  Refusing to seed a member whose token and account id do not match — this is the exact\n` +
        `  wrong-account risk this server is designed to make impossible. `,
    );
  }
  if (body.username && body.username.toLowerCase() !== igUsername.toLowerCase()) {
    console.warn(`  Note: token reports username @${body.username}, you passed @${igUsername}. Using yours for display only.`);
  }
  console.log(`✓ Token verified live as @${body.username ?? igUsername} (id ${liveId}).`);
}

const { encryptToken, generateBearerToken, hashBearerToken } = await import("../src/crypto.js");
const { insertMember } = await import("../src/db.js");

const bearerToken = generateBearerToken();
const expiresAt = new Date(Date.now() + expiresDays * 24 * 60 * 60 * 1000);

const row = await insertMember({
  name,
  token_hash: hashBearerToken(bearerToken),
  ig_user_id: igUserId,
  ig_username: igUsername,
  ig_access_token_encrypted: encryptToken(igToken),
  ig_token_expires_at: expiresAt.toISOString(),
});

console.log(`
✓ Member seeded: ${name} → @${igUsername} (member id ${row.id})
  IG token expires ${expiresAt.toISOString().slice(0, 10)} (auto-refresh runs monthly).

 ────────────────────────────────────────────────────────────────────────
  ${name}'s bearer token — SHOWN ONCE, only a hash is stored:

  ${bearerToken}

  Send it to them over a secure channel (password manager / Signal).
  They paste it into Claude as:  Authorization: Bearer ${bearerToken.slice(0, 12)}�
────────────────────────────────────────────────────────────────────────
`);
