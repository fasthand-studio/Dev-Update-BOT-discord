import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(join(here, "fixtures/schema.sql"), "utf8");

// These must stay byte-identical to the SQL constants in lib/stats.ts.
// lib/stats.ts exports them via a test-only hook so we assert the shipped text.
const { OVERVIEW_SQL, REPO_SQL, CONTRIBUTORS_SQL, DAILY_SQL, NOTABLE_COMMITS_SQL, NOTABLE_PRS_SQL } =
  await import("../lib/stats-sql.js");

const CONN = process.env.TEST_DATABASE_URL ?? "postgresql://postgres@127.0.0.1:55432/postgres";

async function withDb<T>(fn: (q: (text: string, params?: unknown[]) => Promise<any[]>) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: CONN, max: 2 });
  try {
    await pool.query("drop schema public cascade; create schema public;");
    await pool.query(schema);
    const q = async (text: string, params: unknown[] = []) => (await pool.query(text, params as never[])).rows;
    return await fn(q);
  } finally {
    await pool.end();
  }
}

const START = "2024-01-08T00:00:00.000Z";
const END = "2024-01-15T00:00:00.000Z";

const SEED = `
insert into repositories (id, github_id, full_name, owner_login, name, html_url) values
  (1, 101, 'org/alpha', 'org', 'alpha', 'https://github.com/org/alpha'),
  (2, 102, 'org/beta',  'org', 'beta',  'https://github.com/org/beta');

insert into activity_events
  (event_type, action, repo_full_name, actor_login, branch, commit_count, payload, occurred_at) values
  ('push','pushed','org/alpha','alice','main',3,'{}'::jsonb,'2024-01-08T10:00:00Z'),
  ('push','pushed','org/alpha','alice','main',2,'{}'::jsonb,'2024-01-09T10:00:00Z'),
  ('push','pushed','org/beta','bob','develop',1,'{}'::jsonb,'2024-01-10T10:00:00Z'),
  ('pull_request','opened','org/alpha','alice','main',null,'{"pull_request":{"number":1,"merged":false}}'::jsonb,'2024-01-10T11:00:00Z'),
  ('pull_request','closed','org/alpha','alice','main',null,'{"pull_request":{"number":1,"merged":true}}'::jsonb,'2024-01-11T11:00:00Z'),
  ('pull_request','closed','org/beta','bob','develop',null,'{"pull_request":{"number":2,"merged":false}}'::jsonb,'2024-01-11T12:00:00Z'),
  ('release','published','org/beta','bob','main',null,'{}'::jsonb,'2024-01-12T09:00:00Z'),
  ('issues','opened','org/alpha','carol','main',null,'{}'::jsonb,'2024-01-12T09:30:00Z'),
  ('issues','closed','org/alpha','carol','main',null,'{}'::jsonb,'2024-01-12T09:40:00Z'),
  ('push','pushed','org/alpha','alice','main',99,'{}'::jsonb,'2024-01-07T10:00:00Z'),
  ('push','pushed','org/alpha','alice','main',99,'{}'::jsonb,'2024-01-15T10:00:00Z');

insert into commits (repository_id, sha, message, author_login, branch, occurred_at) values
  (1,'a1','add feature','alice','main','2024-01-08T10:00:00Z'),
  (1,'a2','fix bug','alice','main','2024-01-08T10:01:00Z'),
  (1,'a3','refactor','dave','main','2024-01-09T10:00:00Z'),
  (2,'b1','initial','bob','develop','2024-01-10T10:00:00Z'),
  (1,'a4','out of range','alice','main','2024-01-15T10:00:00Z');

insert into pull_request_snapshots
  (repository_id, pr_number, merged, state, additions, deletions, changed_files, merged_at_gh) values
  (1, 1, true, 'closed', 100, 20, 5, '2024-01-11T11:00:00Z'),
  (2, 2, false, 'closed', 0, 0, 0, '2024-01-11T12:00:00Z'),
  (1, 9, true, 'closed', 999, 999, 99, '2024-01-01T00:00:00Z');
`;

test("overview aggregates only the window and counts merged PRs correctly", async () => {
  await withDb(async (q) => {
    await q(SEED);
    const [o] = await q(OVERVIEW_SQL, [START, END]);
    assert.equal(o.commits, 4);
    assert.equal(o.pushes, 3);
    assert.equal(o.pull_requests_opened, 1);
    assert.equal(o.pull_requests_closed, 2);
    assert.equal(o.pull_requests_merged, 1, "only merged:true counts as merged");
    assert.equal(o.releases, 1);
    assert.equal(o.issues_opened, 1);
    assert.equal(o.issues_closed, 1);
    assert.equal(o.branches_touched, 2);
    assert.equal(o.repositories_active, 2);
    assert.equal(o.active_contributors, 3, "alice + bob + carol");
    assert.equal(o.active_days, 3);
    assert.equal(o.lines_added, 100);
    assert.equal(o.lines_removed, 20);
    assert.equal(o.files_changed, 5);
    assert.equal(o.merged_prs, 2);
  });
});

test("per-repo stats group by repo and merge PR file stats", async () => {
  await withDb(async (q) => {
    await q(SEED);
    const rows = await q(REPO_SQL, [START, END]);
    assert.equal(rows.length, 2);

    const alpha = rows.find((r: any) => r.full_name === "org/alpha");
    assert.ok(alpha, "alpha present");
    assert.equal(alpha.commits, 3);
    assert.equal(alpha.pull_requests_opened, 1);
    assert.equal(alpha.pull_requests_merged, 1);
    assert.equal(alpha.issues_opened, 1);
    assert.equal(alpha.issues_closed, 1);
    assert.equal(alpha.contributors, 2, "alice + carol");
    assert.equal(alpha.branches, 1);
    assert.equal(alpha.lines_added, 100);
    assert.equal(alpha.files_changed, 5);

    const beta = rows.find((r: any) => r.full_name === "org/beta");
    assert.ok(beta, "beta present");
    assert.equal(beta.commits, 1);
    assert.equal(beta.releases, 1);
    assert.equal(beta.pull_requests_merged, 0, "closed but not merged");
    assert.equal(beta.lines_added, 0);

    assert.equal(rows[0].full_name, "org/alpha", "sorted by commits desc");
  });
});

test("contributor leaderboard merges commit authors and PR openers", async () => {
  await withDb(async (q) => {
    await q(SEED);
    const rows = await q(CONTRIBUTORS_SQL, [START, END, 25]);
    const alice = rows.find((r: any) => r.login === "alice");
    assert.equal(alice.commits, 2);
    assert.equal(alice.pull_requests, 1);
    assert.equal(alice.repositories, 1);

    const dave = rows.find((r: any) => r.login === "dave");
    assert.equal(dave.commits, 1);
    assert.equal(dave.pull_requests, 0);

    assert.equal(rows.find((r: any) => r.login === "carol"), undefined, "carol has no commits");
  });
});

test("daily commit counts bucket by UTC date", async () => {
  await withDb(async (q) => {
    await q(SEED);
    const rows = await q(DAILY_SQL, [START, END]);
    const map = Object.fromEntries(rows.map((r: any) => [r.date, r.count]));
    assert.equal(map["2024-01-08"], 2);
    assert.equal(map["2024-01-09"], 1);
    assert.equal(map["2024-01-10"], 1);
    assert.equal(Object.keys(map).length, 3);
  });
});

test("notable commits and PRs are scoped to the window", async () => {
  await withDb(async (q) => {
    await q(SEED);
    const commits = await q(NOTABLE_COMMITS_SQL, [START, END]);
    assert.equal(commits.length, 4, "out-of-range commit excluded");
    assert.ok(commits.every((c: any) => c.full_name === "org/alpha" || c.full_name === "org/beta"));

    const prs = await q(NOTABLE_PRS_SQL, [START, END]);
    assert.equal(prs.length, 3);
    const merged = prs.filter((p: any) => p.merged === true);
    assert.equal(merged.length, 1, "only PR #1 merged");
  });
});

test("empty database yields zeroed aggregates rather than errors", async () => {
  await withDb(async (q) => {
    const [o] = await q(OVERVIEW_SQL, [START, END]);
    assert.equal(o.commits, 0);
    assert.equal(o.active_contributors, 0);
    assert.equal(o.lines_added, 0);
    const repos = await q(REPO_SQL, [START, END]);
    assert.equal(repos.length, 0);
  });
});
