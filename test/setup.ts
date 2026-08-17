import { loadEnvLocal } from "../src/env.js";

// Integration tests read real credentials from .env.local when present.
loadEnvLocal();

// Unit tests need a valid encryption key even without .env.local filled in.
// 32 bytes of 'A' — a test-only key, never used for real data.
if (!process.env.TOKEN_ENCRYPTION_KEY) {
  process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, "A").toString("base64");
}
