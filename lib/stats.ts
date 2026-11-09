import { supabase } from "./supabase.js";

export type Period = { start: Date; end: Date };

export function lastNDays(n: number, end = new Date()): Period {
  const e = new Date(end);
  const s = new Date(e);
  s.setUTCDate(s.getUTCDate() - n);
  return { start: s, end: e };
}

export function iso(d: Date): string { return d.toISOString(); }

export async function getOverviewStats(period: Period) {
  const start = iso(period.start);
  const end = iso(period.end);

  const [pushes, commits, prs, releases, issues, repos] = await Promise.all([
    supabase.from("activity_events").select("id", { count: "exact", head: true }).eq("event_type", "push").gte("occurred_at", start).lt("occurred_at", end),
    supabase.from("commits").select("id", { count: "exact", head: true }).gte("occurred_at", start).lt("occurred_at", end),
    supabase.from("activity_events").select("action", { count: "exact" }).eq("event_type", "pull_request").gte("occurred_at", start).lt("occurred_at", end),
    supabase.from("activity_events").select("id", { count: "exact", head: true }).eq("event_type", "release").gte("occurred_at", start).lt("occurred_at", end),
    supabase.from("activity_events").select("id", { count: "exact", head: true }).eq("event_type", "issues").eq("action", "opened").gte("occurred_at", start).lt("occurred_at", end),
    supabase.from("activity_events").select("repo_full_name").gte("occurred_at", start).lt("occurred_at", end).not("repo_full_name", "is", null).limit(5000),
  ]);

  const prRows = prs.data ?? [];
  const prOpened = prRows.filter((r: any) => r.action === "opened" || r.action === "reopened").length;
  const prMerged = prRows.filter((r: any) => r.action === "closed" && (r as any).merged).length || (await countMergedPRs(period));
  const prClosed = prRows.filter((r: any) => r.action === "closed").length;

  const activeRepoNames = new Set((repos.data ?? []).map((r: any) => r.repo_full_name).filter(Boolean));
  const contributors = await getActiveContributorCount(period);

  return {
    commits: commits.count ?? 0,
    pushes: pushes.count ?? 0,
    pullRequestsOpened: prOpened,
    pullRequestsMerged: prMerged,
    pullRequestsClosed: prClosed,
    releases: releases.count ?? 0,
    issuesOpened: issues.count ?? 0,
    activeContributors: contributors,
    repositoriesActive: activeRepoNames.size,
  };
}

async function countMergedPRs(period: Period): Promise<number> {
  const { data } = await supabase
    .from("activity_events")
    .select("payload")
    .eq("event_type", "pull_request")
    .eq("action", "closed")
    .gte("occurred_at", iso(period.start))
    .lt("occurred_at", iso(period.end))
    .limit(2000);
  return (data ?? []).filter((r: any) => r.payload?.pull_request?.merged || r.payload?.merged).length;
}

export async function getActiveContributorCount(period: Period): Promise<number> {
  const start = iso(period.start); const end = iso(period.end);
  const { data } = await supabase
    .from("activity_events")
    .select("actor_login")
    .gte("occurred_at", start).lt("occurred_at", end)
    .not("actor_login", "is", null)
    .limit(10000);
  return new Set((data ?? []).map((r: any) => r.actor_login).filter(Boolean)).size;
}

export async function getTopContributors(period: Period, limit = 10) {
  const { data } = await supabase
    .from("commits")
    .select("author_login")
    .gte("occurred_at", iso(period.start)).lt("occurred_at", iso(period.end))
    .not("author_login", "is", null)
    .limit(10000);
  const counts = new Map<string, number>();
  for (const r of data ?? []) {
    const k = (r as any).author_login;
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([login, commits]) => ({ login, commits }));
}

export async function getRepositoryActivity(period: Period, limit = 15) {
  const { data } = await supabase
    .from("activity_events")
    .select("repo_full_name,event_type,action,payload")
    .gte("occurred_at", iso(period.start)).lt("occurred_at", iso(period.end))
    .not("repo_full_name", "is", null)
    .limit(10000);
  const map = new Map<string, any>();
  for (const r of data ?? [] as any[]) {
    const name = r.repo_full_name;
    if (!map.has(name)) map.set(name, { fullName: name, commits: 0, pullRequestsOpened: 0, pullRequestsMerged: 0, releases: 0, issuesOpened: 0, events: 0 });
    const x = map.get(name);
    x.events++;
    if (r.event_type === "push") x.commits += r.payload?.size ?? r.payload?.commits?.length ?? 0;
    if (r.event_type === "pull_request" && (r.action === "opened" || r.action === "reopened")) x.pullRequestsOpened++;
    if (r.event_type === "pull_request" && r.action === "closed" && r.payload?.pull_request?.merged) x.pullRequestsMerged++;
    if (r.event_type === "release" && r.action === "published") x.releases++;
    if (r.event_type === "issues" && r.action === "opened") x.issuesOpened++;
  }
  return [...map.values()].sort((a, b) => b.events - a.events).slice(0, limit);
}

export async function getNotablePRs(period: Period, limit = 8) {
  const { data } = await supabase
    .from("activity_events")
    .select("repo_full_name,pr_number,title,url,payload,action")
    .eq("event_type", "pull_request")
    .in("action", ["opened", "closed", "merged", "reopened"])
    .gte("occurred_at", iso(period.start)).lt("occurred_at", iso(period.end))
    .order("occurred_at", { ascending: false })
    .limit(limit);
  return (data ?? []).map((r: any) => ({
    repo: r.repo_full_name,
    number: r.pr_number,
    title: r.title ?? r.payload?.pull_request?.title ?? "",
    state: r.action,
    merged: !!r.payload?.pull_request?.merged,
    url: r.url ?? r.payload?.pull_request?.html_url ?? "",
  })).filter((r) => r.repo && r.number);
}

export async function getNotableCommits(period: Period, limit = 12) {
  const { data } = await supabase
    .from("commits")
    .select("sha,message,author_login,url,repository_id,repositories(full_name)")
    .gte("occurred_at", iso(period.start)).lt("occurred_at", iso(period.end))
    .order("occurred_at", { ascending: false })
    .limit(limit);
  return (data ?? []).map((r: any) => ({
    repo: r.repositories?.full_name ?? "unknown",
    sha: String(r.sha).slice(0, 7),
    message: String(r.message ?? "").split("\n")[0],
    author: r.author_login ?? "unknown",
    url: r.url ?? undefined,
  }));
}

export async function getReleases(period: Period, limit = 10) {
  const { data } = await supabase
    .from("activity_events")
    .select("repo_full_name,release_tag,title,url,action")
    .eq("event_type", "release")
    .eq("action", "published")
    .gte("occurred_at", iso(period.start)).lt("occurred_at", iso(period.end))
    .order("occurred_at", { ascending: false })
    .limit(limit);
  return (data ?? []).map((r: any) => ({ repo: r.repo_full_name, tag: r.release_tag, name: r.title, url: r.url }));
}

export async function getDailyCommitCounts(days = 182): Promise<Array<{ date: string; count: number }>> {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days);
  const { data } = await supabase
    .from("commits")
    .select("occurred_at")
    .gte("occurred_at", start.toISOString())
    .lt("occurred_at", end.toISOString())
    .limit(50000);
  const map = new Map<string, number>();
  for (const r of data ?? []) {
    const d = (r as any).occurred_at;
    if (!d) continue;
    const key = new Date(d).toISOString().slice(0, 10);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return [...map.entries()].map(([date, count]) => ({ date, count }));
}
