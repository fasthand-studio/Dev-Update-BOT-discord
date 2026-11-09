import type { VercelRequest, VercelResponse } from "@vercel/node";
import { env } from "../../lib/env.js";
import { syncInstallationsAndRepositories } from "../../lib/github.js";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

// Manual/maintenance endpoint to refresh repository catalog from the GitHub App.
// Always require CRON_SECRET when configured; deny in production if missing.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const secret = env.CRON_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") return res.status(503).json({ error: "CRON_SECRET must be configured" });
  } else {
    const auth = req.headers.authorization;
    if (typeof auth !== "string" || !timingSafeEqual(auth, `Bearer ${secret}`)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }
  try {
    const result = await syncInstallationsAndRepositories();
    return res.status(200).json({ ok: true, ...result });
  } catch (e) {
    console.error("GitHub sync failed", e instanceof Error ? e.message : "unknown error");
    return res.status(500).json({ error: "Sync failed" });
  }
}
