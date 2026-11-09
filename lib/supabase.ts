import { createClient } from "@supabase/supabase-js";
import { env } from "./env.js";

export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export function sbError(context: string, error: { message: string; details?: string; hint?: string; code?: string } | null | undefined): never {
  const parts = [context, error?.message, error?.details, error?.hint, error?.code].filter(Boolean);
  throw new Error(parts.join(" | "));
}
