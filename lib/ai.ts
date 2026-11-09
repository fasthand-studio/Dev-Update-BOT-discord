import { env } from "./env.js";

export type WeeklyAIInput = {
  period: { start: string; end: string };
  totals: {
    commits: number;
    pullRequestsOpened: number;
    pullRequestsMerged: number;
    pullRequestsClosed: number;
    activeContributors: number;
    repositoriesActive: number;
    releases: number;
    issuesOpened: number;
  };
  repositories: Array<{
    fullName: string;
    commits: number;
    pullRequestsOpened: number;
    pullRequestsMerged: number;
    releases: number;
    issuesOpened: number;
  }>;
  contributors: Array<{ login: string; commits: number; pullRequests: number }>;
  notablePullRequests: Array<{ repo: string; number: number; title: string; state: string; merged: boolean; url: string }>;
  notableCommits: Array<{ repo: string; sha: string; message: string; author: string; url?: string }>;
  releases: Array<{ repo: string; tag: string; name?: string; url: string }>;
};

export async function summarizeWeeklyActivity(input: WeeklyAIInput): Promise<string> {
  if (!env.AI_API_KEY) throw new Error("AI_API_KEY is required for weekly AI summaries");

  const system = [
    "You write concise weekly software development summaries for a private team.",
    "You receive structured JSON describing actual GitHub activity for a specific period.",
    "Rules:",
    "- Never assume or mention any organization, project, or repository name unless it appears in the input.",
    "- Summarize only changes supported by the input. Do not invent features, fixes, metrics, or achievements.",
    "- If the input shows limited activity, say so plainly.",
    "- Be factual and professional. Avoid hype.",
    "- Output markdown with short sections: Overview, Highlights, Repositories (only notable ones), Risks/Follow-ups (only if supported by data, otherwise omit).",
    "- Keep it under 350 words.",
  ].join("\n");

  const body = {
    model: env.AI_MODEL,
    temperature: 0.2,
    messages: [
      { role: "system", content: system },
      { role: "user", content: `Summarize this GitHub activity JSON:\n\n${JSON.stringify(input)}` },
    ],
  };

  // OpenAI-compatible chat completions endpoint. Works with OpenAI and many compatible providers when AI_BASE_URL is set.
  if (env.AI_PROVIDER === "anthropic-messages") {
    const res = await fetch(`${env.AI_BASE_URL.replace(/\/$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.AI_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: env.AI_MODEL,
        max_tokens: 700,
        temperature: 0.2,
        system,
        messages: [{ role: "user", content: `Summarize this GitHub activity JSON:\n\n${JSON.stringify(input)}` }],
      }),
    });
    if (!res.ok) throw new Error(`AI request failed: ${res.status} ${await res.text()}`);
    const json = await res.json() as any;
    const text = json?.content?.map((c: any) => c.text).filter(Boolean).join("\n");
    if (!text) throw new Error("AI response missing text");
    return text.trim();
  }

  const base = env.AI_BASE_URL.replace(/\/$/, "");
  const url = base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.AI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`AI request failed: ${res.status} ${await res.text()}`);
  const json = await res.json() as any;
  const text = json?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim()) throw new Error("AI response missing content");
  return text.trim();
}
