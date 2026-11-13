import type { VercelRequest, VercelResponse } from "@vercel/node";
import { env } from "../../lib/env.js";
import { supabase } from "../../lib/supabase.js";
import { sendDiscordWebhookWithFile, clampEmbeds } from "../../lib/discord.js";
import { renderContributionHeatmap } from "../../lib/heatmap.js";
import { summarizeWeeklyActivity, buildFallbackSummary, type WeeklyAIInput } from "../../lib/ai.js";
import { buildWeeklyReportEmbeds } from "../../lib/report.js";
import { getWeeklyReportData, getDailyCommitCounts, lastNDays, iso } from "../../lib/stats.js";

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

    // One aggregation pass in Postgres (or PostgREST fallback).
    const reportData = await getWeeklyReportData(period);
    const { overview, repositories, contributors } = reportData;

    const daily = await getDailyCommitCounts(182);
    const heatmap = renderContributionHeatmap(daily, 26);

    const aiInput: WeeklyAIInput = {
      period: { start: weekStart, end: weekEnd },
      overview,
      repositories,
      contributors,
    };

    let summary = buildFallbackSummary(aiInput);
    let aiUsed = false;
    try {
      summary = await summarizeWeeklyActivity(aiInput);
      aiUsed = true;
    } catch (e) {
      console.error("AI summary failed", e instanceof Error ? e.message : "unknown error");
    }

    const { embeds } = buildWeeklyReportEmbeds({
      period: { start: weekStart, end: weekEnd },
      overview,
      repositories,
      contributors,
      summary,
    });

    const message = await sendDiscordWebhookWithFile(
      env.DISCORD_WEEKLY_WEBHOOK_URL,
      { embeds: clampEmbeds(embeds) },
      { name: "contribution-heatmap.png", contentType: "image/png", data: heatmap },
    );

    await supabase.from("weekly_reports").upsert({
      week_start: weekStart,
      week_end: weekEnd,
      stats: {
        ...overview,
        repositories: repositories.map((r) => ({
          fullName: r.fullName,
          commits: r.commits,
          pullRequestsOpened: r.pullRequestsOpened,
          pullRequestsMerged: r.pullRequestsMerged,
          releases: r.releases,
          issuesOpened: r.issuesOpened,
          filesChanged: r.filesChanged,
          linesAdded: r.linesAdded,
          linesRemoved: r.linesRemoved,
        })),
        contributors,
        headline: summary.headline,
        highlights: summary.highlights,
        repoSummaries: summary.repositories,
      },
      ai_summary: summary.overview,
      discord_message_id: message?.id ? String(message.id) : null,
    }, { onConflict: "week_start" });

    return res.status(200).json({
      ok: true,
      weekStart,
      weekEnd,
      aiUsed,
      totals: overview,
      repos: repositories.length,
      contributors: contributors.length,
    });
  } catch (e) {
    console.error("Weekly cron failed", e instanceof Error ? e.message : "unknown error");
    return res.status(500).json({ error: "Weekly report failed" });
  }
}
