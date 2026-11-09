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
  const lines = input.commits.slice(0, 10).map((c) => {
    const sha = c.sha.slice(0, 7);
    const msg = truncate(c.message.split("\n")[0], 90);
    const link = c.url ? `[\`${sha}\`](${c.url})` : `\`${sha}\``;
    return `${link} ${esc(msg)} — ${esc(c.author)}`;
  });
  const more = input.commits.length > 10 ? `\n…and ${input.commits.length - 10} more` : "";
  return {
    title: `Push to ${input.repoFullName}`,
    url: input.compareUrl ?? input.repoUrl ?? undefined,
    color: COLORS.push,
    description: `**${esc(input.pusher)}** pushed **${input.commits.length}** commit${input.commits.length === 1 ? "" : "s"} to \`${input.branch}\`\n\n${lines.join("\n")}${more}`.slice(0, 4096),
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
  if (input.action === "opened" || input.action === "reopened") color = COLORS.prOpen;
  if (input.action === "closed" && input.merged) { color = COLORS.prMerged; label = "Pull request merged"; }
  else if (input.action === "closed") { color = COLORS.prClosed; label = "Pull request closed"; }
  const fields: DiscordEmbed["fields"] = [{ name: "Repository", value: input.repoFullName, inline: true }];
  if (input.base || input.head) fields.push({ name: "Branches", value: `\`${input.head ?? "?"}\` → \`${input.base ?? "?"}\``, inline: true });
  return {
    title: `#${input.number} ${truncate(input.title, 120)}`,
    url: input.url,
    color,
    description: `**${label}** by ${esc(input.author)}`,
    fields,
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
  return {
    title: `${kind}: ${truncate(input.name || input.tag, 120)}`,
    url: input.url,
    color: COLORS.release,
    description: `**${input.action}** in ${input.repoFullName} by ${esc(input.author)}\nTag: \`${input.tag}\`\n\n${truncate(input.body, 700) || "_No release notes._"}`.slice(0, 4096),
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
  return {
    title: `Issue #${input.number}: ${truncate(input.title, 120)}`,
    url: input.url,
    color: COLORS.issue,
    description: `**${input.action}** in ${input.repoFullName} by ${esc(input.author)}`,
    timestamp: new Date().toISOString(),
  };
}
