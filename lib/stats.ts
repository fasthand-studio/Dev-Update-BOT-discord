import { supabase } from "./supabase.js";
import { query, isPgConfigured } from "./db.js";
import {
  OVERVIEW_SQL, REPO_SQL, CONTRIBUTORS_SQL, DAILY_SQL, NOTABLE_COMMITS_SQL, NOTABLE_PRS_SQL,
} from "./stats-sql.js";

export type Period = { start: Date; end: Date };

export function lastNDays(n: number, end = new Date()): Period {
  const e = new Date(end);
  const s = new Date(e);
  s.setUTCDate(s.getUTCDate() - n);
  return { start: s, end: e };
}

export function iso(d: Date): string { return d.toISOString(); }

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type WeekOverview = {
  commits: number;
  pushes: number;
  pullRequestsOpened: number;
  pullRequestsMerged: number;
  pullRequestsClosed: number;
  releases: number;
  issuesOpened: number;
  issuesClosed: number;
  activeContributors: number;
  repositoriesActive: number;
  activeDays: number;
  branchesTouched: number;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  mergedPrs: number;
};

export type NotableCommit = { sha: string; message: string; author: string; url?: string };
export type NotablePr = { number: number; title: string; state: string; url?: string; merged: boolean };

export type RepoWeekStats = {
  fullName: string;
  commits: number;
  pullRequestsOpened: number;
  pullRequestsMerged: number;
  releases: number;
  issuesOpened: number;
  issuesClosed: number;
  contributors: number;
  branches: number;
  filesChanged: number;
  linesAdded: number;
  linesRemoved: number;
  notableCommits: NotableCommit[];
  notablePRs: NotablePr[];
};

export type ContributorWeekStats = {
  login: string;
  commits: number;
  pullRequests: number;
  repositories: number;
};

export type WeeklyReportData = {
  overview: WeekOverview;
  repositories: RepoWeekStats[];
  contributors: ContributorWeekStats[];
};

/* ------------------------------------------------------------------ */
/* SQL (pg) implementation                                             */
/* ------------------------------------------------------------------ */

// Every query aggregates inside Postgres and returns only the rows we need.
// We never ship a whole `payload` JSONB blob across the wire.
/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export async function getWeeklyReportData(period: Period): Promise<WeeklyReportData> {
  if (isPgConfigured()) {
    const [overviewRows, repoRows, contributorRows] = await Promise.all([
      query(OVERVIEW_SQL, [iso(period.start), iso(period.end)]),
      query(REPO_SQL, [iso(period.start), iso(period.end)]),
      query(CONTRIBUTORS_SQL, [iso(period.start), iso(period.end), 25]),
    ]);

    const o = (overviewRows[0] ?? {}) as Record<string, number>;
    const overview: WeekOverview = {
      commits: o.commits ?? 0,
      pushes: o.pushes ?? 0,
      pullRequestsOpened: o.pull_requests_opened ?? 0,
      pullRequestsMerged: o.pull_requests_merged ?? 0,
      pullRequestsClosed: o.pull_requests_closed ?? 0,
      releases: o.releases ?? 0,
      issuesOpened: o.issues_opened ?? 0,
      issuesClosed: o.issues_closed ?? 0,
      activeContributors: o.active_contributors ?? 0,
      repositoriesActive: o.repositories_active ?? 0,
      activeDays: o.active_days ?? 0,
      branchesTouched: o.branches_touched ?? 0,
      filesChanged: o.files_changed ?? 0,
      linesAdded: o.lines_added ?? 0,
      linesRemoved: o.lines_removed ?? 0,
      mergedPrs: o.merged_prs ?? 0,
    };

    const [commitRows, prRows] = await Promise.all([
      query(NOTABLE_COMMITS_SQL, [iso(period.start), iso(period.end)]),
      query(NOTABLE_PRS_SQL, [iso(period.start), iso(period.end)]),
    ]);

    const commitsByRepo = new Map<string, NotableCommit[]>();
    for (const c of commitRows as any[]) {
      const list = commitsByRepo.get(c.full_name) ?? [];
      if (list.length < 6) {
        list.push({
          sha: String(c.sha ?? "").slice(0, 7),
          message: String(c.message ?? "").split("\n")[0],
          author: c.author_login ?? "unknown",
          url: c.url ?? undefined,
        });
      }
      commitsByRepo.set(c.full_name, list);
    }
    const prsByRepo = new Map<string, NotablePr[]>();
    for (const p of prRows as any[]) {
      const list = prsByRepo.get(p.full_name) ?? [];
      if (list.length < 6) {
        list.push({
          number: p.pr_number,
          title: p.title ?? "",
          state: p.action ?? "",
          url: p.url ?? undefined,
          merged: p.merged === true,
        });
      }
      prsByRepo.set(p.full_name, list);
    }

    const repositories: RepoWeekStats[] = (repoRows as any[]).map((r) => ({
      fullName: r.full_name,
      commits: r.commits ?? 0,
      pullRequestsOpened: r.pull_requests_opened ?? 0,
      pullRequestsMerged: r.pull_requests_merged ?? 0,
      releases: r.releases ?? 0,
      issuesOpened: r.issues_opened ?? 0,
      issuesClosed: r.issues_closed ?? 0,
      contributors: r.contributors ?? 0,
      branches: r.branches ?? 0,
      filesChanged: r.files_changed ?? 0,
      linesAdded: r.lines_added ?? 0,
      linesRemoved: r.lines_removed ?? 0,
      notableCommits: commitsByRepo.get(r.full_name) ?? [],
      notablePRs: prsByRepo.get(r.full_name) ?? [],
    }));

    const contributors: ContributorWeekStats[] = (contributorRows as any[]).map((c) => ({
      login: c.login,
      commits: c.commits ?? 0,
      pullRequests: c.pull_requests ?? 0,
      repositories: c.repositories ?? 0,
    }));

    return { overview, repositories, contributors };
  }

  return getWeeklyReportDataViaRest(period);
}

type EvRow = {
  repo_full_name: string | null;
  event_type: string;
  action: string | null;
  actor_login: string | null;
  branch: string | null;
  merged: boolean | null;
};

function isMerged(row: { merged?: boolean | null }): boolean {
  return row.merged === true;
}

async function fetchEventsViaRest(period: Period): Promise<EvRow[]> {
  const { data, error } = await supabase
    .from("activity_events")
    .select("repo_full_name,event_type,action,actor_login,branch,payload->pull_request->merged")
    .gte("occurred_at", iso(period.start)).lt("occurred_at", iso(period.end))
    .limit(20000);
  if (error) throw new Error(`activity_events query failed: ${error.message}`);
  return (data ?? []) as unknown as EvRow[];
}

async function getWeeklyReportDataViaRest(period: Period): Promise<WeeklyReportData> {
  const events = await fetchEventsViaRest(period);

  const [commitRes, prSnapRes] = await Promise.all([
    supabase
      .from("commits")
      .select("sha,message,author_login,url,repository_id,occurred_at,repositories(full_name)")
      .gte("occurred_at", iso(period.start)).lt("occurred_at", iso(period.end))
      .order("occurred_at", { ascending: false }).limit(5000),
    supabase
      .from("pull_request_snapshots")
      .select("repository_id,pr_number,additions,deletions,changed_files,merged_at_gh,repositories(full_name)")
      .gte("merged_at_gh", iso(period.start)).lt("merged_at_gh", iso(period.end)).limit(5000),
  ]);
  if (commitRes.error) throw new Error(`commits query failed: ${commitRes.error.message}`);
  if (prSnapRes.error) throw new Error(`pull_request_snapshots query failed: ${prSnapRes.error.message}`);

  const commits = (commitRes.data ?? []) as any[];
  const snapshots = (prSnapRes.data ?? []) as any[];

  const repoMap = new Map<string, RepoWeekStats>();
  const ensure = (name: string): RepoWeekStats => {
    let r = repoMap.get(name);
    if (!r) {
      r = {
        fullName: name, commits: 0, pullRequestsOpened: 0, pullRequestsMerged: 0, releases: 0,
        issuesOpened: 0, issuesClosed: 0, contributors: 0, branches: 0, filesChanged: 0,
        linesAdded: 0, linesRemoved: 0, notableCommits: [], notablePRs: [],
      };
      repoMap.set(name, r);
    }
    return r;
  };

  for (const c of commits) {
    const name = c.repositories?.full_name ?? "unknown";
    const r = ensure(name);
    r.commits++;
    if (r.notableCommits.length < 6) {
      r.notableCommits.push({
        sha: String(c.sha ?? "").slice(0, 7),
        message: String(c.message ?? "").split("\n")[0],
        author: c.author_login ?? "unknown",
        url: c.url ?? undefined,
      });
    }
  }

  const branchesByRepo = new Map<string, Set<string>>();
  const actorsByRepo = new Map<string, Set<string>>();
  for (const e of events) {
    const name = e.repo_full_name;
    if (!name) continue;
    const r = ensure(name);
    if (e.event_type === "pull_request" && (e.action === "opened" || e.action === "reopened")) r.pullRequestsOpened++;
    if (e.event_type === "pull_request" && e.action === "closed" && isMerged(e)) r.pullRequestsMerged++;
    if (e.event_type === "release") r.releases++;
    if (e.event_type === "issues" && e.action === "opened") r.issuesOpened++;
    if (e.event_type === "issues" && e.action === "closed") r.issuesClosed++;
    if (e.branch) {
      const set = branchesByRepo.get(name) ?? new Set<string>();
      set.add(e.branch);
      branchesByRepo.set(name, set);
    }
    if (e.actor_login) {
      const set = actorsByRepo.get(name) ?? new Set<string>();
      set.add(e.actor_login);
      actorsByRepo.set(name, set);
    }
  }

  for (const s of snapshots) {
    const name = s.repositories?.full_name;
    if (!name) continue;
    const r = ensure(name);
    r.filesChanged += s.changed_files ?? 0;
    r.linesAdded += s.additions ?? 0;
    r.linesRemoved += s.deletions ?? 0;
  }

  const repositories = [...repoMap.values()];
  for (const r of repositories) {
    r.branches = branchesByRepo.get(r.fullName)?.size ?? 0;
    r.contributors = actorsByRepo.get(r.fullName)?.size ?? 0;
  }
  repositories.sort((a, b) => b.commits - a.commits || b.pullRequestsOpened - a.pullRequestsOpened);

  const contributorMap = new Map<string, ContributorWeekStats>();
  const contributorRepos = new Map<string, Set<string>>();
  for (const c of commits) {
    const login = c.author_login;
    if (!login) continue;
    const e = contributorMap.get(login) ?? { login, commits: 0, pullRequests: 0, repositories: 0 };
    e.commits++;
    contributorMap.set(login, e);
    const name = c.repositories?.full_name;
    if (name) {
      const set = contributorRepos.get(login) ?? new Set<string>();
      set.add(name);
      contributorRepos.set(login, set);
    }
  }
  for (const [login, set] of contributorRepos) {
    const e = contributorMap.get(login);
    if (e) e.repositories = set.size;
  }
  for (const ev of events) {
    if (!ev.actor_login) continue;
    if (ev.event_type === "pull_request" && (ev.action === "opened" || ev.action === "reopened")) {
      const e = contributorMap.get(ev.actor_login) ?? { login: ev.actor_login, commits: 0, pullRequests: 0, repositories: 0 };
      e.pullRequests++;
      contributorMap.set(ev.actor_login, e);
    }
  }
  const contributors = [...contributorMap.values()].sort((a, b) => b.commits - a.commits || b.pullRequests - a.pullRequests);

  const activeDays = new Set(commits.map((c) => String(c.occurred_at ?? "").slice(0, 10)).filter(Boolean));
  const branchesTouched = new Set(events.map((e) => e.branch).filter(Boolean) as string[]).size;
  const overview: WeekOverview = {
    commits: commits.length,
    pushes: events.filter((e) => e.event_type === "push").length,
    pullRequestsOpened: repositories.reduce((s, r) => s + r.pullRequestsOpened, 0),
    pullRequestsMerged: repositories.reduce((s, r) => s + r.pullRequestsMerged, 0),
    pullRequestsClosed: events.filter((e) => e.event_type === "pull_request" && e.action === "closed").length,
    releases: repositories.reduce((s, r) => s + r.releases, 0),
    issuesOpened: repositories.reduce((s, r) => s + r.issuesOpened, 0),
    issuesClosed: repositories.reduce((s, r) => s + r.issuesClosed, 0),
    activeContributors: contributors.length,
    repositoriesActive: repositories.length,
    activeDays: activeDays.size,
    branchesTouched,
    filesChanged: repositories.reduce((s, r) => s + r.filesChanged, 0),
    linesAdded: repositories.reduce((s, r) => s + r.linesAdded, 0),
    linesRemoved: repositories.reduce((s, r) => s + r.linesRemoved, 0),
    mergedPrs: snapshots.length,
  };

  return { overview, repositories, contributors };
}

/* ------------------------------------------------------------------ */
/* Legacy-shaped helpers (kept for the /stats command)                 */
/* ------------------------------------------------------------------ */

export async function getOverviewStats(period: Period): Promise<WeekOverview> {
  const { overview } = await getWeeklyReportData(period);
  return overview;
}

export async function getRepositoryActivity(period: Period, limit = 15) {
  const { repositories } = await getWeeklyReportData(period);
  return repositories.slice(0, limit).map((r) => ({
    fullName: r.fullName,
    commits: r.commits,
    pullRequestsOpened: r.pullRequestsOpened,
    pullRequestsMerged: r.pullRequestsMerged,
    releases: r.releases,
    issuesOpened: r.issuesOpened,
    events: r.commits + r.pullRequestsOpened + r.pullRequestsMerged + r.releases + r.issuesOpened,
  }));
}

export async function getTopContributors(period: Period, limit = 10) {
  const { contributors } = await getWeeklyReportData(period);
  return contributors.slice(0, limit).map((c) => ({ login: c.login, commits: c.commits, pullRequests: c.pullRequests }));
}

export async function getDailyCommitCounts(days = 182): Promise<Array<{ date: string; count: number }>> {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days);

  if (isPgConfigured()) {
    const rows = await query(DAILY_SQL, [iso(start), iso(end)]);
    return (rows as any[]).map((r) => ({ date: r.date, count: r.count }));
  }

  const { data, error } = await supabase
    .from("commits")
    .select("occurred_at")
    .gte("occurred_at", iso(start)).lt("occurred_at", iso(end))
    .limit(50000);
  if (error) throw new Error(`commits query failed: ${error.message}`);
  const map = new Map<string, number>();
  for (const r of data ?? []) {
    const d = (r as any).occurred_at;
    if (!d) continue;
    const key = new Date(d).toISOString().slice(0, 10);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return [...map.entries()].map(([date, count]) => ({ date, count }));
}
