# GitHub Activity Discord Bot

A lightweight, private GitHub development tracking bot built with **TypeScript**, **Vercel Functions**, **Supabase PostgreSQL**, a **GitHub App**, and **Discord** webhooks/interactions.

It is designed to be modular, serverless-friendly, and low-cost: no VPS, no continuously running server, no Cloudflare infrastructure.

## Features

- **Centralized GitHub App webhooks** for authorized public/private repositories across installations/org access.
- **Automatic repository discovery**, including newly added repositories (via installation/repository events and a manual sync endpoint).
- **Real-time Discord updates** for pushes/commits, pull request lifecycle events, releases, and important issue activity.
- **Stored activity history** in Supabase for stats and weekly reporting.
- **Duplicate protection** using GitHub delivery IDs plus external event identifiers where useful.
- **HTTP-based Discord slash commands**: `/stats`, `/contributors`, `/repositories`, `/weekly`, `/repo`.
- **Weekly report** via Vercel Cron with totals, repository activity, a GitHub-style contribution heatmap image, a configurable AI summary, per-repository "what happened" summaries, top contributors, and code stats (files changed, lines added/deleted).

## Architecture

| Concern | Implementation |
|---|---|
| Runtime | Vercel serverless functions (`api/*`) |
| Database | Supabase PostgreSQL (`supabase/migrations/0001_init.sql`) |
| GitHub ingestion | `POST /api/github/webhook` (verified with webhook secret, deduped by delivery ID) |
| Repository catalog | GitHub App installation API; refreshed on installation events and `POST /api/github/sync` |
| Discord updates | Discord channel webhooks |
| Discord commands | `POST /api/discord/interactions` (Ed25519 signature verification, no Gateway) |
| Weekly report | `GET/POST /api/cron/weekly` (Vercel Cron, Friday 1:05 PM Bangladesh time / 07:05 UTC by default) |
| AI summary | Stateless, configurable provider/model; receives structured JSON only |

## Project layout

```text
api/
  github/webhook.ts      # GitHub App webhook receiver
  github/sync.ts         # Protected manual repository sync
  discord/interactions.ts# HTTP slash command endpoint
  cron/weekly.ts         # Weekly report generator
  health.ts              # Health check
lib/
  ai.ts                  # Configurable AI summarizer (stateless)
  dedup.ts               # Delivery/event dedup helpers
  discord.ts             # Discord webhook + interaction verification
  env.ts                 # Environment variable access/validation
  format.ts              # Discord embed formatters
  github.ts              # GitHub App auth and repository sync
  github-events.ts       # GitHub event normalization/notification
  heatmap.ts             # Contribution heatmap PNG renderer
  stats.ts               # Supabase-backed activity queries
  supabase.ts            # Supabase service client
scripts/
  register-discord-commands.ts
supabase/
  migrations/0001_init.sql
```

## Prerequisites

- Node.js 20+
- A Supabase project
- A GitHub App installed on the target account/org with repository access
- A Discord application/bot and two channel webhooks (updates + weekly)
- A Vercel project (Hobby is sufficient for light usage)
- An AI API key for weekly summaries (optional for real-time updates; weekly report will still post with a fallback message if AI is unavailable)

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure Supabase

1. Create a Supabase project.
2. Open the SQL Editor and run [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql).
3. Copy `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from Project Settings > API.

The service role key is required for server-side inserts/queries in Vercel functions. Keep it secret and never expose it to browsers.

### 3. Create and configure the GitHub App

Create a GitHub App (personal account or organization) with:

- **Webhook URL:** `https://<your-vercel-domain>/api/github/webhook`
- **Webhook secret:** a strong random value (`GITHUB_WEBHOOK_SECRET`)
- **Repository permissions** (minimum practical set):
  - Contents: Read-only (commits/push metadata)
  - Issues: Read-only
  - Metadata: Read-only
  - Pull requests: Read-only
- **Subscribe to events:**
  - Installation
  - Installation repositories / Installation target (as available)
  - Push
  - Pull request
  - Release
  - Issues
  - Repository (optional but helpful)
  - Meta/Ping

Install the app on the target account/organization and grant access to all repositories (recommended for automatic discovery) or selected repositories.

After creating the app, collect:
- App ID (`GITHUB_APP_ID`)
- Private key PEM (`GITHUB_APP_PRIVATE_KEY`)
- Installation ID(s) if you want to pin scope (`GITHUB_INSTALLATION_IDS`, optional)

### 4. Configure Discord

1. Create a Discord application in the Developer Portal.
2. Copy `DISCORD_PUBLIC_KEY` and `DISCORD_APPLICATION_ID`.
3. Create a bot for the application and copy `DISCORD_BOT_TOKEN` (used only for slash-command registration).
4. Set the application's **Interactions Endpoint URL** to:
   `https://<your-vercel-domain>/api/discord/interactions`
5. Create two channel webhooks:
   - Updates channel → `DISCORD_UPDATES_WEBHOOK_URL`
   - Weekly reports channel → `DISCORD_WEEKLY_WEBHOOK_URL`

Register slash commands:

```bash
cp .env.example .env.local
# fill DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN
npx tsx scripts/register-discord-commands.ts
```

For faster testing, set `DISCORD_GUILD_ID` to register guild-scoped commands.

### 5. Configure AI (weekly summaries)

The AI summarizer is stateless and receives structured JSON for each request. It never hardcodes project/org names and is instructed not to invent changes.

Supported configuration:
- `AI_PROVIDER=openai-compatible` (default): calls `POST ${AI_BASE_URL}/chat/completions`
- `AI_PROVIDER=anthropic-messages`: calls Anthropic Messages API
- `AI_PROVIDER=cloudflare`: calls Cloudflare Workers AI `POST /client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/run/{AI_MODEL}`

Set `AI_API_KEY` and `AI_MODEL`. For Cloudflare, also set `CLOUDFLARE_ACCOUNT_ID` and use a Cloudflare API token with Workers AI access as `AI_API_KEY` (example model: `@cf/ibm-granite/granite-4.0-h-micro`). `AI_BASE_URL` is optional (defaults to Cloudflare's API base for the Cloudflare provider).

### 6. Deploy to Vercel

1. Push this repository to GitHub/GitLab/Bitbucket.
2. Import into Vercel.
3. Add all environment variables from `.env.example`.
4. Set `CRON_SECRET` to a strong random value. Vercel Cron will send it as `Authorization: Bearer <CRON_SECRET>`.
5. Deploy.

The included [`vercel.json`](vercel.json) configures:
- `/api/cron/weekly` every Friday at 1:05 PM Bangladesh time (`5 7 * * 5` UTC — Vercel cron always runs on UTC). Note: on the Hobby plan Vercel may invoke the job anywhere within that hour, so the report can land between 1:00 PM and 1:59 PM.
- 60s max duration for API functions

Adjust the cron schedule/timezone strategy as needed.

### 7. Initial repository sync (recommended)

After deployment, trigger a protected sync to populate the repository catalog:

```bash
curl -X POST "https://<your-vercel-domain>/api/github/sync" \
  -H "Authorization: Bearer $CRON_SECRET"
```

Subsequent installation/repository events also refresh the catalog.

## Environment variables

See [`.env.example`](.env.example) for the full list.

| Variable | Required | Purpose |
|---|---:|---|
| `SUPABASE_URL` | yes | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Server-side Supabase access |
| `GITHUB_APP_ID` | yes | GitHub App identifier |
| `GITHUB_APP_PRIVATE_KEY` | yes | GitHub App PEM private key (`\n` escaped in env) |
| `GITHUB_WEBHOOK_SECRET` | yes | Verifies GitHub webhook signatures |
| `GITHUB_INSTALLATION_IDS` | no | Restrict processing to specific installations |
| `DISCORD_PUBLIC_KEY` | yes | Verifies Discord interaction signatures |
| `DISCORD_APPLICATION_ID` | yes | Discord application ID |
| `DISCORD_BOT_TOKEN` | yes | Used by command registration script |
| `DISCORD_UPDATES_WEBHOOK_URL` | yes | Real-time activity channel webhook |
| `DISCORD_WEEKLY_WEBHOOK_URL` | yes | Weekly report channel webhook |
| `DATABASE_URL` | no | Direct Postgres connection (Supabase pooler, port 6543). Enables SQL aggregation in the weekly report; falls back to PostgREST when unset. See `.env.example`. |
| `AI_PROVIDER` | no | `openai-compatible`, `anthropic-messages`, or `cloudflare` |
| `AI_API_KEY` | for AI | AI provider API key / Cloudflare API token |
| `AI_BASE_URL` | no | AI API base URL |
| `AI_MODEL` | no | AI model name (for Cloudflare, e.g. `@cf/ibm-granite/granite-4.0-h-micro`) |
| `CLOUDFLARE_ACCOUNT_ID` | for Cloudflare AI | Cloudflare account ID used by Workers AI |
| `CRON_SECRET` | recommended | Protects cron/manual endpoints |

## Reliability notes

- **Duplicate deliveries:** GitHub `X-GitHub-Delivery` IDs are stored in `webhook_deliveries` and ignored on retries.
- **Event-level dedup:** selected events also store `external_id` with a unique constraint.
- **Missed events:** webhooks are the primary source; GitHub may retry failed deliveries. The `/api/github/sync` endpoint can repair repository catalog drift. For strict historical backfill, add a manual import job using GitHub App installation tokens (not included to keep the tool small).
- **Signature verification:** GitHub webhooks require a valid `X-Hub-Signature-256`; Discord interactions require valid Ed25519 headers.
- **Protected maintenance endpoints:** `/api/cron/weekly` and `/api/github/sync` require `CRON_SECRET` (Bearer token) when configured and are denied in production when missing.
- **No hardcoded project identity:** AI summaries and embeds are generated from observed event payloads/database records.

## Public repository security

This codebase can be public **if and only if** secrets remain outside git. See [`SECURITY.md`](SECURITY.md) and [`.env.example`](.env.example). Never commit `.env` files, keys, tokens, webhook secrets, Discord webhook URLs, or AI credentials. Configure secrets in Vercel/Supabase/provider dashboards and rotate immediately if exposed.

## Local checks

```bash
npm run typecheck
```

Vercel-style local development:

```bash
npm i -g vercel
vercel dev
```

For webhook testing locally, use a secure tunnel and point the GitHub App / Discord interactions endpoint to the tunnel URL.

## Operational guidance

- Keep the GitHub App permissions read-only.
- Use separate Discord channels/webhooks for updates and weekly summaries.
- Monitor Vercel function logs for webhook signature failures, Supabase errors, or AI provider errors.
- If activity volume grows, add SQL aggregation views/materialized summaries and tune query limits in `lib/stats.ts`.
