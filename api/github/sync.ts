import type { VercelRequest, VercelResponse } from "@vercel/node";
import { env } from "../../lib/env.js";
import { syncInstallationsAndRepositories } from "../../lib/github.js";

// Manual/maintenance endpoint to refresh repository catalog from the GitHub App.
// Protect with CRON_SECRET to avoid exposing installation enumeration.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (env.CRON_SECRET && req.headers.authorization !== `Bearer ${env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const result = await syncInstallationsAndRepositories();
    return res.status(200).json({ ok: true, ...result });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message ?? e).slice(0, 300) });
  }
}
