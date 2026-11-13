import type { DiscordEmbed } from "./discord.js";
import type { ContributorWeekStats, RepoWeekStats, WeekOverview } from "./stats.js";
import type { WeeklySummary } from "./ai.js";

type EmbedField = { name: string; value: string; inline?: boolean };

/** Discord field values must be non-empty and <= 1024 chars. */
function field(name: string, value: string | number, inline = true): EmbedField {
  const text = String(value).trim();
  return { name, value: text.length ? text.slice(0, 1024) : "—", inline };
}

function shortName(fullName: string): string {
  const parts = fullName.split("/");
  return parts.length > 1 ? parts[parts.length - 1] : fullName;
}

function plural(n: number, word: string): string {
  if (n === 1) return `${n} ${word}`;
  // Common irregular/extra-suffix plurals.
  if (word === "push") return `${n} pushes`;
  if (word === "branch") return `${n} branches`;
  if (word === "release") return `${n} releases`;
  if (word === "issue") return `${n} issues`;
  if (word === "contributor") return `${n} contributors`;
  if (word === "commit") return `${n} commits`;
  if (word === "PR") return `${n} PRs`;
  if (word.endsWith("y") && !/[aeiou]y$/i.test(word)) return `${n} ${word.slice(0, -1)}ies`;
  if (word.endsWith("s") || word.endsWith("sh") || word.endsWith("ch") || word.endsWith("x") || word.endsWith("z")) return `${n} ${word}es`;
  return `${n} ${word}s`;
}

/**
 * Per-repository line: repo name plus a one-line summary of what happened.
 * Falls back to a factual activity breakdown when no AI summary exists.
 */
function repoLine(repo: RepoWeekStats, summary?: string): string {
  const bits: string[] = [];
  if (repo.commits) bits.push(plural(repo.commits, "commit"));
  if (repo.pullRequestsOpened) bits.push(plural(repo.pullRequestsOpened, "PR opened"));
  if (repo.pullRequestsMerged) bits.push(`${repo.pullRequestsMerged} merged`);
  if (repo.releases) bits.push(plural(repo.releases, "release"));
  if (repo.issuesOpened) bits.push(plural(repo.issuesOpened, "issue opened"));

  const stats = bits.length ? bits.join(", ") : "no activity";
  const head = `**${repo.fullName}**`;
  if (!summary) return `• ${head} — ${stats}`;
  return `• ${head} — ${summary}\n   ${stats}`;
}

export type WeeklyReportEmbeds = {
  embeds: DiscordEmbed[];
};

/**
 * Builds the weekly report as a small set of rich embeds:
 *   1. Headline + overall summary + headline stats + heatmap
 *   2. Per-repository breakdown (name + what happened)
 *   3. Contributor leaderboard
 */
export function buildWeeklyReportEmbeds(input: {
  period: { start: string; end: string };
  overview: WeekOverview;
  repositories: RepoWeekStats[];
  contributors: ContributorWeekStats[];
  summary: WeeklySummary;
}): WeeklyReportEmbeds {
  const { period, overview, repositories, contributors, summary } = input;

  /* ---------------- Embed 1: headline + summary ---------------- */
  const overviewLines: string[] = [];
  if (summary.overview) overviewLines.push(summary.overview);
  if (summary.highlights.length) {
    overviewLines.push("");
    for (const h of summary.highlights) overviewLines.push(`• ${h}`);
  }

  const embeds: DiscordEmbed[] = [
    {
      title: summary.headline || "🗓️ Weekly Development Report",
      description: [
        `**Period:** ${period.start} → ${period.end} (UTC)`,
        "",
        ...overviewLines,
      ].join("\n").slice(0, 4096),
      color: 0x1f6feb,
      fields: [
        field("📈 Code", `${plural(overview.commits, "commit")} • ${plural(overview.pushes, "push")}`),
        field("🔀 Pull requests", `${overview.pullRequestsOpened} opened • ${overview.pullRequestsMerged} merged`),
        field("👥 People", `${plural(overview.activeContributors, "contributor")} • ${plural(overview.repositoriesActive, "repo")}`),
        field("🏷️ Releases", plural(overview.releases, "release")),
        field("🐛 Issues", `${overview.issuesOpened} opened • ${overview.issuesClosed} closed`),
        field("📅 Activity", `${plural(overview.activeDays, "active day")} • ${plural(overview.branchesTouched, "branch")}`),
        field("📁 Files changed", overview.filesChanged ? `${overview.filesChanged} • +${overview.linesAdded}/-${overview.linesRemoved}` : "—"),
      ],
      image: { url: "attachment://contribution-heatmap.png" },
      timestamp: new Date().toISOString(),
      footer: { text: "GitHub Activity Bot • tracked webhook activity" },
    },
  ];

  /* ---------------- Embed 2: per-repository breakdown ---------------- */
  if (repositories.length) {
    const lines = repositories
      .slice(0, 10)
      .map((r) => repoLine(r, summary.repositories?.[r.fullName]))
      .join("\n");
    embeds.push({
      title: "📦 What happened, by repository",
      description: lines.slice(0, 4096),
      color: 0x8957e5,
      timestamp: new Date().toISOString(),
      footer: { text: `${plural(repositories.length, "repository")} active this period` },
    });
  }

  /* ---------------- Embed 3: contributors ---------------- */
  if (contributors.length) {
    const lines = contributors
      .slice(0, 10)
      .map((c, i) => {
        const extras: string[] = [];
        if (c.pullRequests) extras.push(`${c.pullRequests} PR`);
        if (c.repositories) extras.push(`${c.repositories} repo${c.repositories === 1 ? "" : "s"}`);
        return `**${i + 1}. ${c.login}** — ${plural(c.commits, "commit")}${extras.length ? ` • ${extras.join(" • ")}` : ""}`;
      })
      .join("\n");
    embeds.push({
      title: "🏆 Most contributed",
      description: lines.slice(0, 4096),
      color: 0xf0883e,
      timestamp: new Date().toISOString(),
      footer: { text: `${plural(contributors.length, "contributor")} took part` },
    });
  }

  return { embeds };
}

/** Compact single-embed variant for the /weekly slash command. */
export function buildWeeklyDigestEmbed(input: {
  period: { start: string; end: string };
  overview: WeekOverview;
  repositories: RepoWeekStats[];
  contributors: ContributorWeekStats[];
  summary: WeeklySummary;
}): DiscordEmbed {
  const { period, overview, repositories, contributors, summary } = input;

  const repoField = repositories.slice(0, 8).map((r) => {
    const s = summary.repositories?.[r.fullName];
    return s ? `• **${shortName(r.fullName)}** — ${s}` : `• **${shortName(r.fullName)}** — ${plural(r.commits, "commit")}`;
  }).join("\n");

  const contribField = contributors.slice(0, 5)
    .map((c, i) => `**${i + 1}. ${c.login}** — ${plural(c.commits, "commit")}`)
    .join("\n");

  const fields: EmbedField[] = [
    field("📈 Commits", overview.commits),
    field("🔀 PRs", `${overview.pullRequestsOpened} opened / ${overview.pullRequestsMerged} merged`),
    field("👥 Contributors", overview.activeContributors),
    field("📦 Repos", overview.repositoriesActive),
    field("🏷️ Releases", overview.releases),
    field("🐛 Issues", overview.issuesOpened),
  ];

  if (repoField) fields.push({ name: "📦 By repository", value: repoField.slice(0, 1024), inline: false });
  if (contribField) fields.push({ name: "🏆 Most contributed", value: contribField.slice(0, 1024), inline: false });

  return {
    title: summary.headline || "🗓️ Weekly Development Report",
    description: `**${period.start} → ${period.end}** (UTC)\n\n${summary.overview}`.slice(0, 4096),
    color: 0x1f6feb,
    fields,
    timestamp: new Date().toISOString(),
    footer: { text: "Full report with heatmap is posted in the weekly channel" },
  };
}
