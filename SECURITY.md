# Security

This repository is safe to publish as **source code** only when secrets are never committed and deployment credentials are stored in platform environment variables (Vercel, Supabase, GitHub, Discord, AI provider). **Do not put real tokens, keys, webhook secrets, or private keys in the repository.**

## What must stay secret

Treat these as credentials:

- `SUPABASE_SERVICE_ROLE_KEY`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_WEBHOOK_SECRET`
- `DISCORD_BOT_TOKEN`
- `DISCORD_PUBLIC_KEY` is not a secret, but keep app config controlled; interactions are verified by signature
- `DISCORD_UPDATES_WEBHOOK_URL` and `DISCORD_WEEKLY_WEBHOOK_URL` (webhook URLs grant posting access)
- `AI_API_KEY`
- `CRON_SECRET`
- `DATABASE_URL` (optional; direct Postgres connection string containing the DB password)

If any credential is accidentally committed, exposed, or posted publicly, **rotate/revoke it immediately** and replace it in Vercel/Supabase/GitHub/Discord/provider dashboards. Rewriting git history does not reliably undo exposure.

## Endpoint protections

| Endpoint | Protection |
|---|---|
| `POST /api/github/webhook` | Requires valid `X-Hub-Signature-256` (GitHub webhook secret). Deduplicates `X-GitHub-Delivery`. |
| `POST /api/discord/interactions` | Requires valid Discord Ed25519 signature headers. |
| `GET/POST /api/cron/weekly` | Requires `Authorization: Bearer <CRON_SECRET>` when `CRON_SECRET` is set; denied in production if missing. |
| `POST /api/github/sync` | Requires `Authorization: Bearer <CRON_SECRET>` when set; denied in production if missing. |
| `GET /api/health` | Public health check; returns no secrets/data. |

## Secure deployment checklist (public repo)

1. **Never commit `.env` files**. `.env.example` contains placeholders only.
2. **Set all secrets in Vercel Project Settings > Environment Variables** (and Supabase for DB credentials). Mark sensitive values as secret where supported.
3. **Use a strong random `CRON_SECRET`** and keep it only in Vercel/manual admin calls.
4. **GitHub App**: use least-privilege read-only permissions (Contents, Metadata, Pull requests, Issues, etc. as needed), subscribe only to required events, and keep the private key out of git.
5. **Discord**: protect bot token and channel webhook URLs; set the Interactions Endpoint URL to your deployed `/api/discord/interactions`.
6. **Supabase**: keep the service role key server-side only. Do not use it in browsers. Review RLS/policies separately if you add client access later (this project uses server-side service access only).
7. **AI provider**: scope/limit the API key where possible; AI input is structured activity JSON and summaries are posted to your private Discord channel.
8. **Monitor logs** for signature failures, auth failures, and unexpected traffic.

## Reporting

If you find a vulnerability in this codebase, avoid posting exploit details publicly before maintainers/operators have a chance to patch and rotate affected credentials.
