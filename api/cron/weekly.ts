import type { VercelRequest, VercelResponse } from "@vercel/node";
import { env } from "../../lib/env.js";
import { supabase } from "../../lib/supabase.js";
import { sendDiscordWebhookWithFile } from "../../lib/discord.js";
import { renderContributionHeatmap } from "../../lib/heatmap.js";
import { summarizeWeeklyActivity } from "../../lib/ai.js";
import {
  getDailyCommitCounts,
  getNotableCommits,
  getNotablePRs,
  getOverviewStats,
  getReleases,
  getRepositoryActivity,
  getTopContributors,
  iso,
  lastNDays,
} from "../../lib/stats.js";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function isAuthorized(req: VercelRequest): boolean {
  // Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` when CRON_SECRET is set.
  // Require a secret in production/public deployments to prevent unauthorized report generation/spend.
  const secret = env.CRON_SECRET;
  if (!secret) {
    return process.env.NODE_ENV !== "production";
  }
  const auth = req.headers.authorization;
  return typeof auth === "string" && timingSafeEqual(auth, `Bearer ${secret}`);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!isAuthorized(req)) return res.status(401).json({ error: "Unauthorized" });

  try {
    const period = lastNDays(7);
    const weekStart = period.start.toISOString().slice(0, 10);
    const weekEnd = period.end.toISOString().slice(0, 10);

    const { data: existing } = await supabase.from("weekly_reports").select("id,discord_message_id").eq("week_start", weekStart).maybeSingle();
    if (existing?.discord_message_id) {
      return res.status(200).json({ ok: true, skipped: true, weekStart });
    }

    const [totals, repoActivity, contributors, notablePRs, notableCommits, releases, daily] = await Promise.all([
      getOverviewStats(period),
      getRepositoryActivity(period, 12),
      getTopContributors(period, 12),
      getNotablePRs(period, 8),
      getNotableCommits(period, 10),
      getReleases(period, 8),
      getDailyCommitCounts(182),
    ]);

    const heatmap = renderContributionHeatmap(daily, 26);

    let aiSummary = "AI summary unavailable: configure AI_API_KEY, AI_BASE_URL (if needed), and AI_MODEL.";
    try {
      aiSummary = await summarizeWeeklyActivity({
        period: { start: iso(period.start), end: iso(period.end) },
        totals,
        repositories: repoActivity.map((r: any) => ({
          fullName: r.fullName, commits: r.commits, pullRequestsOpened: r.pullRequestsOpened,
          pullRequestsMerged: r.pullRequestsMerged, releases: r.releases, issuesOpened: r.issuesOpened,
        })),
        contributors: contributors.map((c) => ({ login: c.login, commits: c.commits, pullRequests: 0 })),
        notablePullRequests: notablePRs,
        notableCommits,
        releases,
      });
    } catch (e) {
      console.error("AI summary failed", e instanceof Error ? e.message : "unknown error");
      aiSummary = "AI summary unavailable. Check server configuration and logs.";
    }

    const repoLines = repoActivity.slice(0, 8).map((r: any) => `• ${r.fullName}: ${r.commits} commits, ${r.pullRequestsOpened} PRs opened, ${r.pullRequestsMerged} merged`).join("\n") || "• No repository activity recorded.";

    const embed = {
      title: `Weekly development report`,
      description: `Period: **${weekStart}** to **${weekEnd}** (UTC)\n\n${aiSummary.slice(0, 3000)}`,
      color: 0x1f6feb,
      fields: [
        { name: "Totals", value: `Commits: **${totals.commits}**\nPRs opened: **${totals.pullRequestsOpened}**\nPRs merged: **${totals.pullRequestsMerged}**\nActive contributors: **${totals.activeContributors}**`, inline: true },
        { name: "Activity", value: `Pushes: **${totals.pushes}**\nReleases: **${totals.releases}**\nIssues opened: **${totals.issuesOpened}**\nActive repos: **${totals.repositoriesActive}**`, inline: true },
        { name: "Repository activity", value: repoLines.slice(0, 1024) },
      ],
      image: { url: "attachment://contribution-heatmap.png" },
      timestamp: new Date().toISOString(),
      footer: { text: "GitHub Activity Bot • data from tracked GitHub webhooks" },
    };

    const message = await sendDiscordWebhookWithFile(env.DISCORD_WEEKLY_WEBHOOK_URL, { embeds: [embed] }, {
      name: "contribution-heatmap.png",
      contentType: "image/png",
      data: heatmap,
    });

    await supabase.from("weekly_reports").upsert({
      week_start: weekStart,
      week_end: weekEnd,
      stats: totals,
      ai_summary: aiSummary,
      discord_message_id: message?.id ? String(message.id) : null,
    }, { onConflict: "week_start" });

    return res.status(200).json({ ok: true, weekStart, weekEnd, totals });
  } catch (e) {
    console.error("Weekly cron failed", e instanceof Error ? e.message : "unknown error");
    return res.status(500).json({ error: "Weekly report failed" });
  }
}
