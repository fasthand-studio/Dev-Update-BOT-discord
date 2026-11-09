import type { VercelRequest, VercelResponse } from "@vercel/node";
import { beginDelivery, finishDelivery } from "../../lib/dedup.js";
import { verifyGitHubWebhook } from "../../lib/github.js";
import { handleGitHubEvent } from "../../lib/github-events.js";

export const config = { api: { bodyParser: false } };

const MAX_BODY_BYTES = 5 * 1024 * 1024;

async function readRawBody(req: VercelRequest): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const raw = await readRawBody(req);
    const sig = req.headers["x-hub-signature-256"];
    const ok = await verifyGitHubWebhook(raw, Array.isArray(sig) ? sig[0] : sig);
    if (!ok) return res.status(401).json({ error: "Invalid signature" });

    const deliveryId = String(req.headers["x-github-delivery"] ?? "");
    const event = String(req.headers["x-github-event"] ?? "");
    if (!deliveryId || !event) return res.status(400).json({ error: "Missing GitHub headers" });

    const isNew = await beginDelivery(deliveryId, "github", event);
    if (!isNew) return res.status(200).json({ ok: true, duplicate: true });

    const payload = raw ? JSON.parse(raw) : {};
    const result = await handleGitHubEvent({ deliveryId, event, payload });
    await finishDelivery(deliveryId, "processed");
    return res.status(200).json({ ok: true, ...result });
  } catch (err: any) {
    const detail = err instanceof Error
      ? `${err.message}${err.stack ? `\n${err.stack}` : ""}`
      : (err?.message || err?.details || err?.hint || err?.code || JSON.stringify(err) || "unknown error");
    console.error("GitHub webhook error", detail);
    const deliveryId = String(req.headers["x-github-delivery"] ?? "");
    if (deliveryId) await finishDelivery(deliveryId, "failed", "processing error").catch(() => null);
    return res.status(500).json({ error: "Webhook processing failed" });
  }
}
