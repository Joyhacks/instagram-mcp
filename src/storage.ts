import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "node:crypto";
import { requireEnv } from "./env.js";

/**
 * Supabase Storage for media uploads. Instagram downloads media from a public
 * URL and will not accept direct file uploads, so slides generated inside a
 * Claude session are parked in the "instagram-media" bucket first.
 *
 * The bucket is public (read-only to anyone with the URL) so Instagram can
 * fetch the images. Only the service role key can upload or delete ℔ anon
 * policy is absent.
 */

const BUCKET = "instagram-media";
const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};

/** Instagram's image size ceiling is 8 MB. Reject earlier with a clear message. */
const MAX_BYTES = 8 * 1024 * 1024;

export interface UploadResult {
  url: string;
  key: string;
  bytes: number;
  contentType: string;
}

function storageClient() {
  return createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_KEY")).storage;
}

/**
 * Upload one image under a per-member key prefix. The member id comes from the
 * authenticated caller, never from tool input, so members cannot write into
 * each other's prefixes.
 */
export async function uploadMedia(
  memberId: string,
  filename: string,
  dataBase64: string,
): Promise<UploadResult> {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  const contentType = CONTENT_TYPES[ext];
  if (!contentType) {
    throw new Error(
      `Unsupported file type ".${ext}". Instagram feed images must be JPEG or PNG, ` +
        `so upload a .png, .jpg, or .jpeg file.`,
    );
  }

  let body: Buffer;
  try {
    body = Buffer.from(dataBase64, "base64");
  } catch {
    throw new Error("data_base64 is not valid base64.");
  }
  if (body.length === 0) {
    throw new Error("data_base64 decoded to zero bytes — the file content is missing.");
  }
  if (body.length > MAX_BYTES) {
    throw new Error(
      `Image is ${(body.length / 1024 / 1024).toFixed(1)} MB; Instagram rejects images over 8 MB. ` +
        `Export the slide smaller and upload again.`,
    );
  }

  // Sanitized original name keeps the bucket browsable; random prefix prevents
  // collisions and guessing.
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
  const now = new Date();
  const yyyymm = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const key = `${memberId}/${yyyymm}/${randomBytes(8).toString("hex")}-${safeName}`;

  const storage = storageClient();
  const { error } = await storage.from(BUCKET).upload(key, body, {
    contentType,
    cacheControl: "31536000", // 1 year — keys are unique per upload, never overwritten
    upsert: false,
  });

  if (error) {
    throw new Error(`Storage upload failed: ${error.message}`);
  }

  const { data } = storage.from(BUCKET).getPublicUrl(key);
  return { url: data.publicUrl, key, bytes: body.length, contentType };
}
