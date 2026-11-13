function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value : undefined;
}

function optionalBool(name: string, fallback = false): boolean {
  const value = optional(name);
  if (value == null) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export const env = {
  get SUPABASE_URL() { return required("SUPABASE_URL"); },
  get SUPABASE_SERVICE_ROLE_KEY() { return required("SUPABASE_SERVICE_ROLE_KEY"); },

  get GITHUB_APP_ID() { return required("GITHUB_APP_ID"); },
  get GITHUB_APP_PRIVATE_KEY() {
    // Vercel env vars often store newlines as \n
    return required("GITHUB_APP_PRIVATE_KEY").replace(/\\n/g, "\n");
  },
  get GITHUB_WEBHOOK_SECRET() { return required("GITHUB_WEBHOOK_SECRET"); },
  // Optional: limit to specific installation IDs (comma-separated). If unset, all installations are used.
  get GITHUB_INSTALLATION_IDS() {
    const raw = optional("GITHUB_INSTALLATION_IDS");
    return raw ? raw.split(",").map((s) => Number(s.trim())).filter(Boolean) : undefined;
  },

  get DISCORD_PUBLIC_KEY() { return required("DISCORD_PUBLIC_KEY"); },
  get DISCORD_APPLICATION_ID() { return required("DISCORD_APPLICATION_ID"); },
  get DISCORD_BOT_TOKEN() { return required("DISCORD_BOT_TOKEN"); },
  get DISCORD_UPDATES_WEBHOOK_URL() { return required("DISCORD_UPDATES_WEBHOOK_URL"); },
  get DISCORD_WEEKLY_WEBHOOK_URL() { return required("DISCORD_WEEKLY_WEBHOOK_URL"); },

  // AI is configurable and optional at runtime? Weekly summary requires it; we should error clearly when used.
  get AI_PROVIDER() { return optional("AI_PROVIDER") ?? "openai-compatible"; },
  get AI_API_KEY() { return optional("AI_API_KEY"); },
  get AI_BASE_URL() { return optional("AI_BASE_URL") ?? "https://api.openai.com/v1"; },
  get AI_MODEL() { return optional("AI_MODEL") ?? "gpt-4o-mini"; },
  get CLOUDFLARE_ACCOUNT_ID() { return optional("CLOUDFLARE_ACCOUNT_ID"); },

  get CRON_SECRET() { return optional("CRON_SECRET"); },
  get LOG_DEBUG() { return optionalBool("LOG_DEBUG", false); },

  // Direct Postgres connection (Supabase pooler, transaction mode, port 6543).
  // Optional: when unset the app falls back to the PostgREST client in lib/supabase.ts.
  get DATABASE_URL() { return optional("DATABASE_URL"); },
};
