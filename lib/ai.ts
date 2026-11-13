import { env } from "./env.js";
import type { ContributorWeekStats, RepoWeekStats, WeekOverview } from "./stats.js";

export type WeeklyAIInput = {
  period: { start: string; end: string };
  overview: WeekOverview;
  repositories: RepoWeekStats[];
  contributors: ContributorWeekStats[];
};

async function fetchJson(url: string, init: RequestInit, timeoutMs = 25000): Promise<any> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`AI request failed: ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** Extract a JSON object from a model response that may be wrapped in prose or code fences. */
export function extractJson(text: string): any | null {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1] : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

const SYSTEM_RULES = [
  "You write concise weekly software development summaries for a private team.",
  "You receive structured JSON describing actual GitHub activity for a specific period.",
  "Rules:",
  "- Never assume or mention any organization, project, or repository name unless it appears in the input.",
  "- Summarize only changes supported by the input. Do not invent features, fixes, metrics, or achievements.",
  "- If the input shows limited activity, say so plainly.",
  "- Never contradict the numeric totals in the input (e.g. do not say a PR was merged if pullRequestsMerged is 0).",
  "- Be factual and professional. Avoid hype.",
].join("\n");

function buildMessages(system: string, user: string) {
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

async function complete(system: string, user: string, maxTokens = 900): Promise<string> {
  if (!env.AI_API_KEY) throw new Error("AI_API_KEY is required for weekly AI summaries");
  const messages = buildMessages(system, user);

  if (env.AI_PROVIDER === "cloudflare") {
    const accountId = env.CLOUDFLARE_ACCOUNT_ID;
    if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID is required when AI_PROVIDER=cloudflare");
    const model = env.AI_MODEL || "@cf/ibm/granite-4.0-h-micro";
    const base = (env.AI_BASE_URL && env.AI_BASE_URL !== "https://api.openai.com/v1")
      ? env.AI_BASE_URL.replace(/\/$/, "")
      : "https://api.cloudflare.com/client/v4";
    const url = `${base}/accounts/${accountId}/ai/run/${model}`;
    const json = await fetchJson(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.AI_API_KEY}`,
      },
      body: JSON.stringify({ messages, temperature: 0.2, max_tokens: maxTokens }),
    });
    if (json?.success === false) throw new Error(`AI request failed: ${json?.errors?.[0]?.message ?? "cloudflare error"}`);
    const result = json?.result;
    const text =
      (typeof result?.response === "string" && result.response) ||
      (typeof result?.result?.response === "string" && result.result.response) ||
      (typeof result?.message?.content === "string" && result.message.content) ||
      (Array.isArray(result?.choices) && typeof result.choices[0]?.message?.content === "string" && result.choices[0].message.content) ||
      (typeof result === "string" && result) ||
      (typeof json?.response === "string" && json.response);
    if (typeof text !== "string" || !text.trim()) throw new Error("AI response missing content");
    return text.trim();
  }

  if (env.AI_PROVIDER === "anthropic-messages") {
    const json = await fetchJson(`${env.AI_BASE_URL.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.AI_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: env.AI_MODEL,
        max_tokens: maxTokens,
        temperature: 0.2,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    const text = json?.content?.map((c: any) => c.text).filter(Boolean).join("\n");
    if (!text) throw new Error("AI response missing text");
    return text.trim();
  }

  const base = env.AI_BASE_URL.replace(/\/$/, "");
  const url = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
  const json = await fetchJson(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.AI_API_KEY}`,
    },
    body: JSON.stringify({ model: env.AI_MODEL, temperature: 0.2, messages }),
  });
  const text = json?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new Error("AI response missing content");
  return text.trim();
}

/* ------------------------------------------------------------------ */
/* Structured weekly summary                                           */
/* ------------------------------------------------------------------ */

export type WeeklySummary = {
  headline: string;
  overview: string;
  highlights: string[];
  repositories: Record<string, string>;
};

const SUMMARY_SYSTEM = [
  SYSTEM_RULES,
  "Return ONLY a JSON object, no prose and no code fences, with this exact shape:",
  '{',
  '  "headline": "one short sentence, max 90 chars, the single most important thing that happened",',
  '  "overview": "2-4 sentences summarizing the whole period",',
  '  "highlights": ["up to 4 short bullet strings"],',
  '  "repositories": { "<repo full name>": "one sentence about what happened in that repo" }',
  "}",
  "- Include a repositories entry for EVERY repo present in the input, using its exact full name as the key.",
  "- Each repository sentence must be specific to that repo's own commits, pull requests, or releases.",
  "- Use the exact contributor logins and repository full names from the input (do not change casing, spacing, or spelling).",
  "- A repository with commits or pull requests is NOT quiet. Describe what the commits/PRs were about, based on the commit messages and PR titles provided.",
  "- Only call a repo quiet if it has zero commits, zero pull requests, zero releases, and zero issues.",
  "- Do not use markdown formatting inside the strings.",
].join("\n");

/**
 * Build a compact, AI-friendly view of the period. We deliberately send
 * commit messages and PR titles (the human signal) rather than raw payloads,
 * so the model can say what actually happened instead of just counting rows.
 */
function toAiPayload(input: WeeklyAIInput) {
  const repos = input.repositories.slice(0, 12).map((r) => ({
    name: r.fullName,
    commits: r.commits,
    pullRequestsOpened: r.pullRequestsOpened,
    pullRequestsMerged: r.pullRequestsMerged,
    releases: r.releases,
    issuesOpened: r.issuesOpened,
    contributors: r.contributors,
    branches: r.branches,
    filesChanged: r.filesChanged,
    linesAdded: r.linesAdded,
    linesRemoved: r.linesRemoved,
    recentCommits: r.notableCommits.map((c) => ({ message: c.message, author: c.author })),
    pullRequestTitles: r.notablePRs.map((p) => ({ number: p.number, title: p.title, merged: p.merged })),
  }));

  const contributors = input.contributors.slice(0, 12).map((c) => ({
    login: c.login,
    commits: c.commits,
    pullRequests: c.pullRequests,
    repositories: c.repositories,
  }));

  return {
    period: input.period,
    totals: input.overview,
    repositories: repos,
    contributors,
  };
}

export async function summarizeWeeklyActivity(input: WeeklyAIInput): Promise<WeeklySummary> {
  const text = await complete(
    SUMMARY_SYSTEM,
    `Summarize this GitHub activity JSON:\n\n${JSON.stringify(toAiPayload(input))}`,
    1400,
  );

  const parsed = extractJson(text);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("AI response was not valid JSON");
  }

  const headline = typeof parsed.headline === "string" ? parsed.headline.trim() : "";
  const overview = typeof parsed.overview === "string" ? parsed.overview.trim() : "";
  const highlights = Array.isArray(parsed.highlights)
    ? parsed.highlights.filter((h: unknown) => typeof h === "string").map((h: string) => h.trim()).filter(Boolean).slice(0, 4)
    : [];
  const repositories: Record<string, string> = {};
  if (parsed.repositories && typeof parsed.repositories === "object") {
    for (const [k, v] of Object.entries(parsed.repositories as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim()) repositories[k.trim()] = v.trim();
    }
  }

  if (!headline && !overview) throw new Error("AI response missing summary content");

  return { headline, overview, highlights, repositories };
}

/**
 * Deterministic fallback used when the AI provider is unavailable or
 * misbehaves. Still produces a useful, factual report.
 */
export function buildFallbackSummary(input: WeeklyAIInput): WeeklySummary {
  const { overview, repositories, contributors } = input;
  const topRepo = repositories[0];
  const topContributor = contributors[0];

  const headline = topRepo
    ? `${topRepo.fullName} led with ${topRepo.commits} commit${topRepo.commits === 1 ? "" : "s"}`
    : `${overview.commits} commits recorded`;

  const parts: string[] = [];
  parts.push(`${overview.commits} commits and ${overview.pushes} pushes across ${overview.repositoriesActive} repositor${overview.repositoriesActive === 1 ? "y" : "ies"}.`);
  if (overview.pullRequestsOpened || overview.pullRequestsMerged) {
    parts.push(`${overview.pullRequestsOpened} pull request${overview.pullRequestsOpened === 1 ? "" : "s"} opened, ${overview.pullRequestsMerged} merged.`);
  }
  if (overview.releases) parts.push(`${overview.releases} release${overview.releases === 1 ? "" : "s"} published.`);
  if (overview.issuesOpened) parts.push(`${overview.issuesOpened} issue${overview.issuesOpened === 1 ? "" : "s"} opened.`);
  if (overview.activeContributors) parts.push(`${overview.activeContributors} contributor${overview.activeContributors === 1 ? "" : "s"} took part.`);

  const repoMap: Record<string, string> = {};
  for (const r of repositories) {
    const bits: string[] = [`${r.commits} commit${r.commits === 1 ? "" : "s"}`];
    if (r.pullRequestsOpened) bits.push(`${r.pullRequestsOpened} PR opened`);
    if (r.pullRequestsMerged) bits.push(`${r.pullRequestsMerged} PR merged`);
    if (r.releases) bits.push(`${r.releases} release`);
    if (r.issuesOpened) bits.push(`${r.issuesOpened} issue opened`);
    repoMap[r.fullName] = bits.join(", ") + ".";
  }

  const highlights: string[] = [];
  if (topContributor) highlights.push(`Top contributor: ${topContributor.login} (${topContributor.commits} commits)`);
  if (overview.filesChanged) highlights.push(`${overview.filesChanged} files changed across merged PRs`);
  if (overview.activeDays) highlights.push(`Active on ${overview.activeDays} day${overview.activeDays === 1 ? "" : "s"}`);

  return { headline, overview: parts.join(" "), highlights, repositories: repoMap };
}
