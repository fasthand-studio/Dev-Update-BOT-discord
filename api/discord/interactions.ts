import type { VercelRequest, VercelResponse } from "@vercel/node";
import { CHANNEL_MESSAGE, PONG, verifyDiscordInteraction, type DiscordEmbed } from "../../lib/discord.js";
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

function embedMsg(embed: DiscordEmbed) {
  return { type: CHANNEL_MESSAGE, data: { embeds: [embed], allowed_mentions: { parse: [] } } };
}

function infoEmbed(title: string, description: string, color = 0x5865f2): DiscordEmbed {
  return { title, description: description.slice(0, 4096), color, timestamp: new Date().toISOString() };
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

    const payload = await withTimeout((async () => {
      if (name === "stats") {
        const s = await getOverviewStats(period);
        return embedMsg({
          title: `📊 Development Stats`,
          description: `Activity for the last **${days} day${days === 1 ? "" : "s"}**`,
          color: 0x5865f2,
          fields: [
            { name: "Commits", value: `\`${s.commits}\``, inline: true },
            { name: "Pushes", value: `\`${s.pushes}\``, inline: true },
            { name: "Contributors", value: `\`${s.activeContributors}\``, inline: true },
            { name: "PRs Opened", value: `\`${s.pullRequestsOpened}\``, inline: true },
            { name: "PRs Merged", value: `\`${s.pullRequestsMerged}\``, inline: true },
            { name: "PRs Closed", value: `\`${s.pullRequestsClosed}\``, inline: true },
            { name: "Releases", value: `\`${s.releases}\``, inline: true },
            { name: "Issues Opened", value: `\`${s.issuesOpened}\``, inline: true },
            { name: "Active Repos", value: `\`${s.repositoriesActive}\``, inline: true },
          ],
          footer: { text: "GitHub Activity Bot" },
          timestamp: new Date().toISOString(),
        });
      }

      if (name === "contributors") {
        const top = await getTopContributors(period, 12);
        if (!top.length) return embedMsg(infoEmbed("👥 Contributors", `No commit activity found in the last **${days} day${days === 1 ? "" : "s"}**.`, 0x6b7280));
        const medals = ["🥇", "🥈", "🥉"];
        const lines = top.map((c, i) => `${medals[i] ?? `\`${String(i + 1).padStart(2, " ")}.\``} **${c.login}** — ${c.commits} commit${c.commits === 1 ? "" : "s"}`).join("\n");
        return embedMsg({
          title: "👥 Top Contributors",
          description: `By commits in the last **${days} day${days === 1 ? "" : "s"}**\n\n${lines}`.slice(0, 4096),
          color: 0x238636,
          footer: { text: "GitHub Activity Bot" },
          timestamp: new Date().toISOString(),
        });
      }

      if (name === "repositories") {
        const { data, error } = await supabase.from("repositories").select("full_name,private,archived,html_url").eq("active", true).order("full_name").limit(30);
        if (error) throw error;
        const rows = data ?? [];
        if (!rows.length) return embedMsg(infoEmbed("📦 Repositories", "No repositories discovered yet. Install the GitHub App and trigger a sync or wait for a webhook event.", 0x6b7280));
        const lines = rows.map((r: any) => `${r.private ? "🔒" : "📂"} [${r.full_name}](${r.html_url ?? `https://github.com/${r.full_name}`})${r.archived ? " `archived`" : ""}`).join("\n");
        return embedMsg({
          title: "📦 Tracked Repositories",
          description: `Showing **${rows.length}** active repositor${rows.length === 1 ? "y" : "ies"}\n\n${lines}`.slice(0, 4096),
          color: 0x1f6feb,
          footer: { text: "GitHub Activity Bot" },
          timestamp: new Date().toISOString(),
        });
      }

      if (name === "repo") {
        const rawRepo = opt(interaction, "name");
        if (!rawRepo) return embedMsg(infoEmbed("🔎 Repository", "Provide a repository name, e.g. `/repo name:owner/repo`.", 0x6b7280));
        const repo = rawRepo.replace(/[^\w./-]/g, "").slice(0, 120);
        if (!repo) return embedMsg(infoEmbed("🔎 Repository", "Provide a valid repository name, e.g. `owner/repo`.", 0x6b7280));
        const { data, error } = await supabase
          .from("repositories").select("id,full_name,html_url,private,archived,default_branch,pushed_at,description")
          .ilike("full_name", `%${repo}%`).limit(5);
        if (error) throw error;
        const match = (data ?? [])[0];
        if (!match) return embedMsg(infoEmbed("🔎 Repository", `No tracked repository matching \`${repo}\`.`, 0x6b7280));
        const since = lastNDays(days);
        const [{ count: commitCount }, { count: prCount }] = await Promise.all([
          supabase.from("commits").select("id", { count: "exact", head: true }).eq("repository_id", match.id).gte("occurred_at", since.start.toISOString()),
          supabase.from("activity_events").select("id", { count: "exact", head: true }).eq("repository_id", match.id).eq("event_type", "pull_request").gte("occurred_at", since.start.toISOString()),
        ]);
        return embedMsg({
          title: `${match.private ? "🔒" : "📂"} ${match.full_name}`,
          url: match.html_url ?? undefined,
          description: match.description ? String(match.description).slice(0, 250) : undefined,
          color: 0x8957e5,
          fields: [
            { name: "Visibility", value: match.private ? "Private" : "Public", inline: true },
            { name: "Status", value: match.archived ? "Archived" : "Active", inline: true },
            { name: "Default Branch", value: `\`${match.default_branch ?? "unknown"}\``, inline: true },
            { name: `Last ${days} Days`, value: `**${commitCount ?? 0}** commits • **${prCount ?? 0}** PR events`, inline: false },
            { name: "Last Push", value: match.pushed_at ? `<t:${Math.floor(new Date(match.pushed_at).getTime() / 1000)}:R>` : "Unknown", inline: true },
          ],
          footer: { text: "GitHub Activity Bot" },
          timestamp: new Date().toISOString(),
        });
      }

      if (name === "weekly") {
        const { data, error } = await supabase.from("weekly_reports").select("week_start,week_end,stats,ai_summary,discord_message_id").order("week_start", { ascending: false }).limit(1).maybeSingle();
        if (error) throw error;
        if (!data) return embedMsg(infoEmbed("🗓️ Weekly Report", "No weekly report has been generated yet. Check Vercel cron configuration and required environment variables.", 0x6b7280));
        const s = data.stats as any;

        // Rebuild the digest from the stored report so the slash command shows
        // the same per-repository breakdown as the posted report.
        const repoSummaries: Record<string, string> = s?.repoSummaries ?? {};
        const repoStats: any[] = Array.isArray(s?.repositories) ? s.repositories : [];
        const contributorStats: any[] = Array.isArray(s?.contributors) ? s.contributors : [];

        const repoField = repoStats.slice(0, 8).map((r) => {
          const text = repoSummaries[r.fullName];
          const stats: string[] = [`${r.commits ?? 0} commits`];
          if (r.pullRequestsOpened) stats.push(`${r.pullRequestsOpened} PR opened`);
          if (r.pullRequestsMerged) stats.push(`${r.pullRequestsMerged} merged`);
          if (r.releases) stats.push(`${r.releases} release`);
          return text ? `• **${r.fullName}** — ${text}\n   ${stats.join(", ")}` : `• **${r.fullName}** — ${stats.join(", ")}`;
        }).join("\n");

        const contribField = contributorStats.slice(0, 5)
          .map((c, i) => `**${i + 1}. ${c.login}** — ${c.commits ?? 0} commits${c.pullRequests ? ` • ${c.pullRequests} PR` : ""}`)
          .join("\n");

        const summary = data.ai_summary ? String(data.ai_summary).slice(0, 3500) : "_No AI summary available._";
        const headline = s?.headline ? String(s.headline) : "🗓️ Latest Weekly Report";

        const fields: any[] = [
          { name: "📈 Commits", value: `\`${s?.commits ?? 0}\``, inline: true },
          { name: "🔀 PRs", value: `\`${s?.pullRequestsOpened ?? 0}\` opened / \`${s?.pullRequestsMerged ?? 0}\` merged`, inline: true },
          { name: "👥 Contributors", value: `\`${s?.activeContributors ?? 0}\``, inline: true },
          { name: "📦 Repos", value: `\`${s?.repositoriesActive ?? 0}\``, inline: true },
          { name: "🏷️ Releases", value: `\`${s?.releases ?? 0}\``, inline: true },
          { name: "🐛 Issues", value: `\`${s?.issuesOpened ?? 0}\``, inline: true },
          { name: "📁 Files changed", value: `\`${s?.filesChanged ?? 0}\``, inline: true },
          { name: "📅 Active days", value: `\`${s?.activeDays ?? 0}\``, inline: true },
        ];
        if (repoField) fields.push({ name: "📦 By repository", value: repoField.slice(0, 1024), inline: false });
        if (contribField) fields.push({ name: "🏆 Most contributed", value: contribField.slice(0, 1024), inline: false });

        return embedMsg({
          title: headline.slice(0, 256),
          description: `**${data.week_start} → ${data.week_end}** (UTC)\n\n${summary}`.slice(0, 4096),
          color: 0x1f6feb,
          fields,
          footer: { text: "Full report (with heatmap) is posted in the weekly channel" },
          timestamp: new Date().toISOString(),
        });
      }

      return msg(`Unknown command: ${name ?? "?"}`);
    })());

    return res.status(200).json(payload);
  } catch (e) {
    console.error("Discord interaction error", e instanceof Error ? e.message : "unknown error");
    return res.status(200).json(embedMsg(infoEmbed("⚠️ Command Error", "Something went wrong while processing that command. Please try again or check server logs.", 0xed4245)));
  }
}
