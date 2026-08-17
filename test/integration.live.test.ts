/**
 * Live integration tests — acceptance tests 2, 3, 4, and 7. These hit real
 * services, so they only run when the relevant credentials exist in .env.local
 * (loaded by test/setup.ts) and are otherwise reported as skipped.
 *
 *   Test 2 (upload_media → browser-loadable URL)  needs SUPABASE_* vars.
 *   Test 7 (check_token_health plausibility)      needs SUPABASE_* + a seeded member
 *                                                 + LIVE_MEMBER_BEARER_TOKEN.
 *   Test 3 (two-slide carousel → real post)       additionally needs LIVE_PUBLISH=1,
 *                                                 because it creates a REAL Instagram post.
 *   Test 4 (two members → own accounts)           needs LIVE_PUBLISH=1 and
 *                                                 LIVE_MEMBER_BEARER_TOKEN_2 for the
 *                                                 second member.
 *
 * Example:
 *   LIVE_MEMBER_BEARER_TOKEN=igmcp_... LIVE_PUBLISH=1 npm test
 */
import { describe, expect, it } from "vitest";
import { resolveMemberFromToken } from "../src/auth.js";
import { checkAccountReachable, getPublishingLimit, publishWithIdempotency } from "../src/instagram.js";
import { uploadMedia } from "../src/storage.js";

const hasDb = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_KEY;
const member1Token = process.env.LIVE_MEMBER_BEARER_TOKEN;
const member2Token = process.env.LIVE_MEMBER_BEARER_TOKEN_2;
const livePublish = process.env.LIVE_PUBLISH === "1";

// A real 1080×1350 PNG (Instagram 4:5 portrait), generated at test time.
async function testPng(label: string): Promise<string> {
  // Minimal valid PNG without native deps: a tiny checkerboard scaled by
  // Instagram is enough to verify the pipeline; content is irrelevant.
  const { deflateSync } = await import("node:zlib");
  const width = 1080;
  const height = 1350;
  const bytesPerRow = width * 3 + 1;
  const raw = Buffer.alloc(bytesPerRow * height);
  const seed = label.length;
  for (let y = 0; y < height; y++) {
    raw[y * bytesPerRow] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const o = y * bytesPerRow + 1 + x * 3;
      const on = ((x >> 6) + (y >> 6) + seed) % 2 === 0;
      raw[o] = on ? 30 : 240;
      raw[o + 1] = on ? 30 : 90;
      raw[o + 2] = on ? 120 : 60;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typeAndData));
    return Buffer.concat([len, typeAndData, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return png.toString("base64");
}

describe.skipIf(!hasDb)("acceptance 2: upload_media returns a browser-loadable URL", () => {
  it("uploads a real PNG to Supabase Storage and the returned URL serves it publicly", async () => {
    const b64 = await testPng("upload-test");
    const result = await uploadMedia("integration-test-member", "acceptance-2.png", b64);
    expect(result.url).toMatch(/^https?:\/\//);

    const res = await fetch(result.url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBe(Buffer.from(b64, "base64").length);
  });
});

describe.skipIf(!hasDb || !member1Token)("acceptance 7: check_token_health plausibility", () => {
  it("resolves the member and reports a plausible expiry (0–60 days) and reachability", async () => {
    const member = await resolveMemberFromToken(member1Token);
    expect(member).not.toBeNull();
    const daysLeft = (member!.igTokenExpiresAt.getTime() - Date.now()) / 864e5;
    expect(daysLeft).toBeGreaterThan(-1);
    expect(daysLeft).toBeLessThanOrEqual(61);

    const live = await checkAccountReachable(member!);
    expect(live.reachable).toBe(true);

    const limit = await getPublishingLimit(member!);
    expect(limit.cap).toBeGreaterThanOrEqual(25);
    expect(limit.remaining).toBeGreaterThanOrEqual(0);
    expect(limit.remaining).toBeLessThanOrEqual(limit.cap);
  });
});

describe.skipIf(!hasDb || !member1Token || !livePublish)(
  "acceptance 3: two-slide carousel lands as a real post",
  () => {
    it("publishes and returns a working permalink", async () => {
      const member = await resolveMemberFromToken(member1Token);
      expect(member).not.toBeNull();

      const slide1 = await uploadMedia(member!.id, "live-slide-1.png", await testPng("s1"));
      const slide2 = await uploadMedia(member!.id, "live-slide-2.png", await testPng("s2"));

      const result = await publishWithIdempotency(
        member!,
        [slide1.url, slide2.url],
        `Acceptance test 3 — ${new Date().toISOString().slice(0, 16)}`,
      );

      expect(result.mediaId).toMatch(/^\d+$/);
      expect(result.permalink).toMatch(/instagram\.com/);
      const res = await fetch(result.permalink!, { redirect: "follow" });
      expect(res.status).toBeLessThan(400); // permalink resolves
    }, 300_000);
  },
);

describe.skipIf(!hasDb || !member1Token || !member2Token || !livePublish)(
  "acceptance 4: two members publish to their OWN accounts (the one that matters most)",
  () => {
    it("each bearer token routes to its own Instagram account", async () => {
      const memberA = await resolveMemberFromToken(member1Token);
      const memberB = await resolveMemberFromToken(member2Token);
      expect(memberA).not.toBeNull();
      expect(memberB).not.toBeNull();
      expect(memberA!.igUserId).not.toBe(memberB!.igUserId); // genuinely different accounts

      const stamp = new Date().toISOString().slice(0, 16);
      const slideA = await uploadMedia(memberA!.id, "cross-a.png", await testPng("a"));
      const slideB = await uploadMedia(memberB!.id, "cross-b.png", await testPng("b"));

      const postA = await publishWithIdempotency(memberA!, [slideA.url], `Acceptance 4A — ${stamp}`);
      const postB = await publishWithIdempotency(memberB!, [slideB.url], `Acceptance 4B — ${stamp}`);

      // The strongest cross-account assertion available from the API side:
      // each post's media id is retrievable ONLY with its own member's token,
      // and each member's media list contains their own post and not the other's.
      const ownA = await fetch(
        `https://graph.instagram.com/v25.0/${memberA!.igUserId}/media?fields=id&limit=10&access_token=${memberA!.igAccessToken}`,
      ).then((r) => r.json() as Promise<{ data: Array<{ id: string }> }>);
      const ownB = await fetch(
        `https://graph.instagram.com/v25.0/${memberB!.igUserId}/media?fields=id&limit=10&access_token=${memberB!.igAccessToken}`,
      ).then((r) => r.json() as Promise<{ data: Array<{ id: string }> }>);

      expect(ownA.data.map((m) => m.id)).toContain(postA.mediaId);
      expect(ownB.data.map((m) => m.id)).toContain(postB.mediaId);
      expect(ownA.data.map((m) => m.id)).not.toContain(postB.mediaId);
      expect(ownB.data.map((m) => m.id)).not.toContain(postA.mediaId);
    }, 300_000);
  },
);
