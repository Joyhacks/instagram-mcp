import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Read a required environment variable, failing with an actionable message
 * instead of an undefined-somewhere-later error.
 */
export function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing required environment variable ${key}. ` +
        `Fill it in .env.local (local) or the Vercel project settings (deployed).`,
    );
  }
  return value.trim();
}

/**
 * Minimal .env.local loader for the CLI scripts (add-member, refresh-tokens).
 * On Vercel the platform injects env vars, so this is never called there.
 * Deliberately tiny instead of pulling in dotenv: KEY=VALUE lines, # comments,
 * optional surrounding quotes. Existing process.env values win.
 */
export function loadEnvLocal(dir: string = process.cwd()): void {
  let raw: string;
  try {
    raw = readFileSync(resolve(dir, ".env.local"), "utf8");
  } catch {
    return; // no .env.local — rely on the ambient environment
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
