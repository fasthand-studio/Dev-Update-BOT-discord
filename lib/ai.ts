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

  const messages = [
    { role: "system", content: system },
    { role: "user", content: `Summarize this GitHub activity JSON:\n\n${JSON.stringify(input)}` },
  ];

  if (env.AI_PROVIDER === "cloudflare") {
    const accountId = env.CLOUDFLARE_ACCOUNT_ID;
    if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID is required when AI_PROVIDER=cloudflare");
    const model = env.AI_MODEL || "@cf/ibm-granite/granite-4.0-h-micro";
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
      body: JSON.stringify({ messages, temperature: 0.2, max_tokens: 700 }),
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

  // OpenAI-compatible chat completions endpoint. Works with OpenAI and many compatible providers when AI_BASE_URL is set.
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
        max_tokens: 700,
        temperature: 0.2,
        system,
        messages: [{ role: "user", content: `Summarize this GitHub activity JSON:\n\n${JSON.stringify(input)}` }],
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
