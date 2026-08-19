/**
 * ONE-TIME admin endpoint to seed a team member from the Vercel server side.
 * Protected by CRON_SECRET. DELETE THIS FILE after seeding is complete.
 *
 * POST /api/admin/seed-member?secret=<CRON_SECRET>
 * Body: { name, igUserId, igUsername, igToken, expiresDays? }
 * Returns: { bearerToken, memberId }
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  encryptToken,
  generateBearerToken,
  hashBearerToken,
} from "../../src/crypto.js";
import { insertMember } from "../../src/db.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const secret = process.env.CRON_SECRET;
  if (secret && req.query.secret !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { name, igUserId, igUsername, igToken, expiresDays = 60 } =
    req.body as {
      name?: string;
      igUserId?: string;
      igUsername?: string;
      igToken?: string;
      expiresDays?: number;
    };

  if (!name || !igUserId || !igUsername || !igToken) {
    return res
      .status(400)
      .json({ error: "Missing required fields: name, igUserId, igUsername, igToken" });
  }

  try {
    const bearerToken = generateBearerToken();
    const expiresAt = new Date(
      Date.now() + Number(expiresDays) * 24 * 60 * 60 * 1000
    );

    const row = await insertMember({
      name,
      token_hash: hashBearerToken(bearerToken),
      ig_user_id: igUserId,
      ig_username: igUsername.replace(/^@/, ""),
      ig_access_token_encrypted: encryptToken(igToken),
      ig_token_expires_at: expiresAt.toISOString(),
    });

    return res.status(200).json({
      memberId: row.id,
      name: row.name,
      igUsername: row.ig_username,
      expiresAt: expiresAt.toISOString().slice(0, 10),
      bearerToken,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: msg });
  }
}
