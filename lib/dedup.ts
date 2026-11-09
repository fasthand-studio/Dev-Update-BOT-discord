import { supabase } from "./supabase.js";

export async function beginDelivery(deliveryId: string, source: string, eventType?: string): Promise<boolean> {
  const { error } = await supabase.from("webhook_deliveries").insert({
    delivery_id: deliveryId,
    source,
    event_type: eventType ?? null,
    status: "received",
  });
  if (!error) return true;
  // unique violation => duplicate/retry
  if (error.code === "23505") return false;
  throw error;
}

export async function finishDelivery(deliveryId: string, status: "processed" | "ignored" | "failed", error?: string) {
  await supabase.from("webhook_deliveries").update({
    status,
    error: error ?? null,
    processed_at: new Date().toISOString(),
  }).eq("delivery_id", deliveryId);
}
