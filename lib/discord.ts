import { verifyKey } from "discord-interactions";
import { env } from "./env.js";

export type DiscordEmbed = {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  author?: { name: string; url?: string; icon_url?: string };
  footer?: { text: string; icon_url?: string };
  timestamp?: string;
  image?: { url: string };
  thumbnail?: { url: string };
};

export async function verifyDiscordInteraction(rawBody: string, signature: string | null, timestamp: string | null): Promise<boolean> {
  if (!signature || !timestamp) return false;
  return verifyKey(rawBody, signature, timestamp, env.DISCORD_PUBLIC_KEY);
}

export async function sendDiscordWebhook(
  webhookUrl: string,
  payload: { content?: string; embeds?: DiscordEmbed[]; username?: string },
): Promise<Response> {
  const res = await fetch(`${webhookUrl}?wait=true`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Discord webhook failed: ${res.status} ${text}`);
  }
  return res;
}

export async function sendDiscordWebhookWithFile(
  webhookUrl: string,
  payload: { content?: string; embeds?: DiscordEmbed[]; username?: string },
  file: { name: string; contentType: string; data: Uint8Array },
): Promise<any> {
  const form = new FormData();
  form.append("payload_json", JSON.stringify(payload));
  const bytes = Uint8Array.from(file.data);
  form.append("files[0]", new Blob([bytes], { type: file.contentType }), file.name);
  const res = await fetch(`${webhookUrl}?wait=true`, { method: "POST", body: form });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`Discord webhook file failed: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

export function interactionResponse(type: number, data?: any) {
  return new Response(JSON.stringify({ type, data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// Interaction response types
export const PONG = 1;
export const CHANNEL_MESSAGE = 4;
export const DEFERRED_CHANNEL_MESSAGE = 5;
