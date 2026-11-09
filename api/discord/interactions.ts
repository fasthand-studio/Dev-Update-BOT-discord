import type { VercelRequest, VercelResponse } from "@vercel/node";
import { CHANNEL_MESSAGE, PONG, verifyDiscordInteraction } from "../../lib/discord.js";
import { getOverviewStats, getRepositoryActivity, getTopContributors, lastNDays } from "../../lib/stats.js";
import { supabase } from "../../lib/supabase.js";

export const config = { api: { bodyParser: false } };

const MAX_BODY_BYTES = 256 * 1024;

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

function opt(interaction: any, name: string): string | undefined {
  const options = interaction?.data?.options ?? [];
  const found = options.find((o: any) => o.name === name);
  return found?.value != null ? String(found.value) : undefined;
}

function msg(content: string) {
  return { type: CHANNEL_MESSAGE, data: { content: content.slice(0, 1900), allowed_mentions: { parse: [] } } };
}

function errMsg(e: unknown) {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/(key|token|secret)=[^\s&]+/gi, "$1=[redacted]").slice(0, 300);
}

async function withTimeout<T>(p: Promise<T>, ms = 2800): Promise<T> {
  return await Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`Timed out after ${ms}ms`)), ms)),
  ]);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") return res.status(405).send("Method not allowed");
  try {
    const raw = await readRawBody(req);
    const sig = req.headers["x-signature-ed25519"];
    const ts = req.headers["x-signature-timestamp"];
    const ok = await verifyDiscordInteraction(raw, Array.isArray(sig) ? sig[0] : sig ?? null, Array.isArray(ts) ? ts[0] : ts ?? null);
    if (!ok) return res.status(401).send("Invalid request signature");

    const interaction = JSON.parse(raw);
    if (interaction.type === 1) return res.status(200).json({ type: PONG });

    const name = interaction?.data?.name;
    const days = Math.min(90, Math.max(1, Number(opt(interaction, "days") ?? "7") || 7));
    const period = lastNDays(days);

    const content = await withTimeout((async () => {
      if (name === "stats") {
        const s = await getOverviewStats(period);
        return [
          `**Development stats (last ${days} days)**`,
          `Commits: **${s.commits}** | Pushes: **${s.pushes}**`,
          `PRs opened: **${s.pullRequestsOpened}** | merged: **${s.pullRequestsMerged}** | closed: **${s.pullRequestsClosed}**`,
          `Releases: **${s.releases}** | Issues opened: **${s.issuesOpened}**`,
          `Active contributors: **${s.activeContributors}** | Active repositories: **${s.repositoriesActive}**`,
        ].join("\n");
      }

      if (name === "contributors") {
        const top = await getTopContributors(period, 12);
        if (!top.length) return `No contributor commit activity found in the last ${days} days.`;
        return `**Top contributors by commits (last ${days} days)**\n` + top.map((c, i) => `${i + 1}. ${c.login} — ${c.commits}`).join("\n");
      }

      if (name === "repositories") {
        const { data, error } = await supabase.from("repositories").select("full_name,private,archived").eq("active", true).order("full_name").limit(30);
        if (error) throw error;
        const rows = data ?? [];
        if (!rows.length) return "No repositories discovered yet. Install the GitHub App and wait for a webhook or trigger a repository sync.";
        return `**Tracked repositories (${rows.length}${rows.length === 30 ? "+" : ""})**\n` + rows.map((r: any) => `• ${r.private ? "🔒" : "📦"} ${r.full_name}${r.archived ? " _(archived)_" : ""}`).join("\n");
      }

      if (name === "repo") {
        const rawRepo = opt(interaction, "name");
        if (!rawRepo) return "Provide a repository name, e.g. `owner/repo`.";
        const repo = rawRepo.replace(/[^\w./-]/g, "").slice(0, 120);
        if (!repo) return "Provide a valid repository name, e.g. `owner/repo`.";
        const { data, error } = await supabase
          .from("repositories").select("id,full_name,html_url,private,archived,default_branch,pushed_at")
          .ilike("full_name", `%${repo}%`).limit(5);
        if (error) throw error;
        const match = (data ?? [])[0];
        if (!match) return `No tracked repository matching \`${repo}\`.`;
        const since = lastNDays(days);
        const [{ count: commitCount }, { count: prCount }] = await Promise.all([
          supabase.from("commits").select("id", { count: "exact", head: true }).eq("repository_id", match.id).gte("occurred_at", since.start.toISOString()),
          supabase.from("activity_events").select("id", { count: "exact", head: true }).eq("repository_id", match.id).eq("event_type", "pull_request").gte("occurred_at", since.start.toISOString()),
        ]);
        return [
          `**${match.full_name}** ${match.private ? "(private)" : "(public)"}${match.archived ? " archived" : ""}`,
          match.html_url ?? "",
          `Default branch: \`${match.default_branch ?? "unknown"}\``,
          `Last push: ${match.pushed_at ?? "unknown"}`,
          `Last ${days} days: ${commitCount ?? 0} commits, ${prCount ?? 0} PR events`,
        ].filter(Boolean).join("\n");
      }

      if (name === "weekly") {
        const { data, error } = await supabase.from("weekly_reports").select("week_start,week_end,stats,ai_summary").order("week_start", { ascending: false }).limit(1).maybeSingle();
        if (error) throw error;
        if (!data) return "No weekly report has been generated yet. Configure the Vercel cron job and required environment variables.";
        const s = data.stats as any;
        const header = `**Weekly report (${data.week_start} to ${data.week_end})**\nCommits: ${s?.commits ?? 0} | PRs opened: ${s?.pullRequestsOpened ?? 0} | merged: ${s?.pullRequestsMerged ?? 0} | contributors: ${s?.activeContributors ?? 0}`;
        const summary = data.ai_summary ? `\n\n${String(data.ai_summary).slice(0, 1400)}` : "";
        return header + summary;
      }

      return `Unknown command: ${name ?? "?"}`;
    })());

    return res.status(200).json(msg(content));
  } catch (e) {
    console.error("Discord interaction error", e instanceof Error ? e.message : "unknown error");
    return res.status(200).json(msg("Command failed. Check server logs for details."));
  }
}
