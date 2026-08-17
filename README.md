# instagram-mcp

A remote MCP server that lets each team member publish Instagram carousels and single images directly from a Claude conversation — to **their own** Instagram professional account, and nobody else's.

The bearer token identifies the person. The person maps to exactly one Instagram account in the database. No tool ever takes an Instagram account id as a parameter, so posting to a teammate's account by passing the wrong id is structurally impossible.

The Meta app runs in **Development mode** with every team member added as an **Instagram Tester** — No Meta App Review, no OAuth login flow, no going Live. That is deliberate.

---

## Connect it to Claude (send this section to a teammate as-is)

You need two things from the admin: the server URL and **your personal access token** (starts with `igmcp_`). Keep the token like a password — anyone holding it can post to your Instagram account.

1. In Claude, open **Settings → Connectors → Add custom connector**.
2. Paste this URL:

   ```
   https://YOUR-DEPLOYMENT.vercel.app/api/mcp
   ```

   *(the admin will give you the real hostname)*
3. Where the connector asks for authentication, add this header — Name on the left, value on the right:

   ```
   Authorization: Bearer igmcp_your_token_here
   ```

   Header name: `Authorization`. Header value: the word `Bearer`, one space, then your token. Nothing else.
4. Save. In any conversation, you can now say things like *"publish these 5 slides as a carousel with this caption"* and Claude will upload the images and post them **to your account**.

What you can ask Claude to do:

- **Publish a carousel** (2–10 images, one caption for the whole post)
- **Publish a single image**
- **Check how many posts you have left today** (Instagram caps API publishing at 100 per 24h)
- **Check your token health** (your Instagram connection auto-renews well before it expires; this tells you if anything's wrong)
- **List your recent posts** (only ever yours)

If a publish fails halfway, just ask Claude to try the same publish again — the server resumes where it left off and will not double-post.

---

## Onboarding a new team member (admin)

Prerequisites, once per person:

1. Their Instagram account must be a **professional account** (Business or Creator).
2. On [developers.facebook.com](https://developers.facebook.com) open the Meta app → **Instagram → API setup with Instagram Login** → add their account as an **Instagram Tester**. They must **accept the invitation** (Instagram app → Settings → Website permissions → Apps and websites → Tester invites).
3. Generate a **long-lived access token** for their account from the app dashboard (the "Generate token" button next to the tester account). Copy the token and note the account's **user id**.

Then seed them (from your machine, in this repo, with `.env.local` filled):

```bash
npm run add-member -- --name "Ada" --ig-user-id 17840000000000000 --ig-username ada.builds
# pastes the long-lived IG token when prompted (kept out of shell history)
```

The script verifies the token live against `graph.instagram.com`, refuses to seed if the token belongs to a different account than the id you passed, and prints the member's `igmcp_` bearer token **once**. Send it to them over a secure channel along with the "Connect it to Claude" section above.

To revoke someone: set `revoked_at = now()` on their row in `team_members`. Their token starts returning 401 immediately.

---

## Architecture

```
instagram-mcp/
├── api/
│   ├── mcp.ts                 # MCP endpoint (Streamable HTTP), bearer auth wrapper
│   └── cron/refresh-tokens.ts # Vercel Cron target (daily; refreshes tokens nearing expiry)
├── src/
│   ├── auth.ts                # bearer lookup → resolves the calling member
│   ├── crypto.ts              # AES-256-GCM for IG tokens, SHA-256 for bearer hashes
│   ├── instagram.ts           # containers, polling, publish, refresh, idempotent resume
│   ├── storage.ts             # R2 uploads (per-member key prefix)
│   ├── db.ts                  # Supabase (service role)
│   ├── refresh.ts             # refresh loop shared by cron + CLI
│   └── tools/                 # one file per tool
├── scripts/
│   ├── add-member.ts          # seeds a member, generates their bearer token
│   └── refresh-tokens.ts      # manual run of the refresh loop
├── supabase/migrations/       # schema (already applied via the Supabase connector)
├── .env.example               # every key, documented
└── README.md
```

Key decisions:

- **Transport**: [`mcp-handler`](https://www.npmjs.com/package/mcp-handler) v2 (Vercel's MCP adapter) with `@modelcontextprotocol/server` v2 — Streamable HTTP only; the deprecated HTTP+SSE transport was removed upstream in v2, which is exactly what we want. No hand-rolled transport.
- **Host**: everything talks to `https://graph.instagram.com` (Instagram Login path). `graph.facebook.com` belongs to the Facebook Login path and fails with a misleading token-parse error — most tutorials get this wrong.
- **Auth**: `Authorization: Bearer <token>` on every request. The token is hashed (SHA-256), looked up, and re-checked with a constant-time comparison; unknown and revoked tokens 401 before any processing. Instagram tokens live AES-256-GCM-encrypted in Postgres; bearer tokens are never stored raw.
- **Idempotency**: the idempotency key (member + image URLs + caption) is written to `posts` before any Meta call. Child container ids are persisted as they're created. A retry reuses FINISHED children, recreates only EXPBREDERRORed ones, and re-publishing the same parent container id is safe (`media_publish` is idempotent per container) — so a half-published carousel can never duplicate.
- **Token refresh**: Vercel Cron runs **daily**; tokens last 60 days and each is refreshed once it enters a 25-day renewal window, so a failed run gets a fresh retry every 24h rather than one shot per month. One member failing never aborts the loop; permanent failures (revoked access, account-type change) mark the row and surface through `check_token_health` instead of retrying forever.

## Deploying (admin)

```bash
npm install
npm run typecheck && npm test     # 19 unit tests, live tests skip without creds

vercel login
vercel link                        # or create the project
# Set every var from .env.example in Vercel → Project → Settings → Environment Variables
vercel --prod
```

Then put the deployment URL into the "Connect it to Claude" section above.

**Supabase must be a dedicated project** that hosts only this server — not a project shared with another app. `team_members` and `posts` are generic names and the service-role client has full table access, so sharing a schema with an unrelated product is a collision (and blast-radius) risk. Create the project under your own account, then apply the migration in `supabase/migrations/` via the SQL editor or the Supabase MCP connector.

R2 bucket needs public access enabled (custom domain or r2.dev) matching `R2_PUBLIC_BASE_URL`.

### Live acceptance tests

With `.env.local` filled and at least one member seeded:

```bash
LIVE_MEMBER_BEARER_TOKEN=igmcp_...            npm test   # upload + token health, no posting
LIVE_MEMBER_BEARER_TOKEN=igmcp_... LIVE_PUBLISH=1 npm test   # ⚠ creates REAL posts
# add LIVE_MEMBER_BEARER_TOKEN_2=igmcp_... for the two-members-two-accounts test
```

## Operational notes

- **Quiet failure mode #1 is an expired token** — posting stops and nobody notices. The cron marks failures loudly (non-200 → red run in the Vercel dashboard) and `check_token_health` reports days-to-expiry and refresh failures per member.
- Instagram caps publishing at **100 posts per account per rolling 24h**; `get_publishing_limit` reads the live counter.
- Containers expire after ~24h and there's a ceiling of ~50 pending containers per account — another reason the retry path reuses containers instead of minting new ones.
- Keep carousel slides the **same aspect ratio**; Instagram crops everything to match the first slide. JPEG/PNG only, ≤ 8 MB.
