import type { DiscordEmbed } from "./discord.js";

const COLORS = {
  push: 0x24292e,
  prOpen: 0x238636,
  prMerged: 0x8957e5,
  prClosed: 0xda3633,
  prUpdate: 0x58a6ff,
  release: 0xf0883e,
  issue: 0xd29922,
  info: 0x5865f2,
  weekly: 0x1f6feb,
};

function truncate(text: string | null | undefined, max = 280): string {
  const t = (text ?? "").replace(/\r/g, "").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function esc(text: string | null | undefined): string {
  return truncate(text, 500).replace(/([*_`~|>\[\]()])/g, "\\$1");
}

export function formatPushEmbed(input: {
  repoFullName: string;
  repoUrl?: string | null;
  pusher: string;
  branch: string;
  commits: Array<{ sha: string; message: string; author: string; url?: string | null }>;
  compareUrl?: string | null;
}): DiscordEmbed {
  const lines = input.commits.slice(0, 8).map((c) => {
    const sha = c.sha.slice(0, 7);
    const msg = truncate(c.message.split("\n")[0], 100);
    const link = c.url ? `[\`${sha}\`](${c.url})` : `\`${sha}\``;
    return `> ${link} ${esc(msg)}\n> — *${esc(c.author)}*`;
  });
  const more = input.commits.length > 8 ? `\n*…and ${input.commits.length - 8} more commit${input.commits.length - 8 === 1 ? "" : "s"}*` : "";
  return {
    author: { name: input.repoFullName, url: input.repoUrl ?? undefined },
    title: `⬆️ ${input.commits.length} commit${input.commits.length === 1 ? "" : "s"} pushed to \`${input.branch}\``,
    url: input.compareUrl ?? input.repoUrl ?? undefined,
    color: COLORS.push,
    description: `**${esc(input.pusher)}** pushed to **${input.repoFullName}**\n\n${lines.join("\n")}${more}`.slice(0, 4096),
    footer: { text: "GitHub Push" },
    timestamp: new Date().toISOString(),
  };
}

export function formatPREmbed(input: {
  repoFullName: string;
  repoUrl?: string | null;
  action: string;
  number: number;
  title: string;
  url: string;
  author: string;
  base?: string | null;
  head?: string | null;
  merged?: boolean;
}): DiscordEmbed {
  let color = COLORS.prUpdate;
  let label = `Pull request ${input.action}`;
  let icon = "🔄";
  if (input.action === "opened" || input.action === "reopened") { color = COLORS.prOpen; icon = "🟢"; }
  if (input.action === "closed" && input.merged) { color = COLORS.prMerged; label = "Pull request merged"; icon = "🟣"; }
  else if (input.action === "closed") { color = COLORS.prClosed; label = "Pull request closed"; icon = "🔴"; }
  if (input.action === "synchronize") { label = "Pull request updated"; icon = "🔄"; }
  if (input.action === "ready_for_review") { label = "Pull request ready for review"; icon = "👀"; }
  const fields: DiscordEmbed["fields"] = [
    { name: "Repository", value: `[${input.repoFullName}](${input.repoUrl ?? input.url})`, inline: true },
    { name: "Author", value: esc(input.author), inline: true },
  ];
  if (input.base || input.head) fields.push({ name: "Branches", value: `\`${input.head ?? "?"}\` → \`${input.base ?? "?"}\``, inline: true });
  return {
    title: `${icon} #${input.number} ${truncate(input.title, 120)}`,
    url: input.url,
    color,
    description: `**${label}**`,
    fields,
    footer: { text: "GitHub Pull Request" },
    timestamp: new Date().toISOString(),
  };
}

export function formatReleaseEmbed(input: {
  repoFullName: string;
  action: string;
  tag: string;
  name?: string | null;
  url: string;
  author: string;
  body?: string | null;
  prerelease?: boolean;
  draft?: boolean;
}): DiscordEmbed {
  const kind = input.draft ? "Draft release" : input.prerelease ? "Pre-release" : "Release";
  const icon = input.prerelease ? "🧪" : "🚀";
  return {
    author: { name: input.repoFullName },
    title: `${icon} ${kind}: ${truncate(input.name || input.tag, 120)}`,
    url: input.url,
    color: COLORS.release,
    description: truncate(input.body, 900) || "_No release notes provided._",
    fields: [
      { name: "Tag", value: `\`${input.tag}\``, inline: true },
      { name: "Author", value: esc(input.author), inline: true },
      { name: "Action", value: esc(input.action), inline: true },
    ],
    footer: { text: "GitHub Release" },
    timestamp: new Date().toISOString(),
  };
}

export function formatIssueEmbed(input: {
  repoFullName: string;
  action: string;
  number: number;
  title: string;
  url: string;
  author: string;
}): DiscordEmbed {
  const icon = input.action === "closed" ? "✅" : input.action === "reopened" ? "🔁" : "🪲";
  return {
    author: { name: input.repoFullName },
    title: `${icon} Issue #${input.number}: ${truncate(input.title, 120)}`,
    url: input.url,
    color: input.action === "closed" ? 0x8957e5 : COLORS.issue,
    description: `**${esc(input.action[0]?.toUpperCase() + input.action.slice(1))}** by ${esc(input.author)}`,
    footer: { text: "GitHub Issue" },
    timestamp: new Date().toISOString(),
  };
}
