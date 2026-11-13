// Central source of truth for the SQL used by lib/stats.ts when a direct
// Postgres connection (DATABASE_URL) is configured. The test suite in
// tests/stats-sql.test.ts imports these constants and runs them against a
// real Postgres instance, so any change here must keep those tests green.

export const OVERVIEW_SQL = `
with ev as (
  select event_type, action, actor_login, branch, repo_full_name, commit_count, payload
  from activity_events
  where occurred_at >= $1::timestamptz and occurred_at < $2::timestamptz
),
cm as (
  select count(*)::int as commits,
         count(distinct occurred_at::date)::int as active_days,
         count(distinct author_login)::int as commit_authors
  from commits
  where occurred_at >= $1::timestamptz and occurred_at < $2::timestamptz
)
select
  (select commits from cm) as commits,
  (select active_days from cm) as active_days,
  (select count(*)::int from ev where event_type = 'push') as pushes,
  (select count(*)::int from ev where event_type = 'pull_request' and action in ('opened','reopened')) as pull_requests_opened,
  (select count(*)::int from ev where event_type = 'pull_request' and action = 'closed') as pull_requests_closed,
  (select count(*)::int from ev where event_type = 'pull_request' and action = 'closed'
     and coalesce((payload->'pull_request'->>'merged')::boolean, (payload->>'merged')::boolean, false)) as pull_requests_merged,
  (select count(*)::int from ev where event_type = 'release') as releases,
  (select count(*)::int from ev where event_type = 'issues' and action = 'opened') as issues_opened,
  (select count(*)::int from ev where event_type = 'issues' and action = 'closed') as issues_closed,
  (select count(distinct branch)::int from ev where branch is not null) as branches_touched,
  (select count(distinct repo_full_name)::int from ev where repo_full_name is not null) as repositories_active,
  (select count(distinct actor_login)::int from ev where actor_login is not null) as active_contributors,
  (select coalesce(sum(additions),0)::int from pull_request_snapshots
     where merged_at_gh >= $1::timestamptz and merged_at_gh < $2::timestamptz) as lines_added,
  (select coalesce(sum(deletions),0)::int from pull_request_snapshots
     where merged_at_gh >= $1::timestamptz and merged_at_gh < $2::timestamptz) as lines_removed,
  (select coalesce(sum(changed_files),0)::int from pull_request_snapshots
     where merged_at_gh >= $1::timestamptz and merged_at_gh < $2::timestamptz) as files_changed,
  (select count(*)::int from pull_request_snapshots
     where merged_at_gh >= $1::timestamptz and merged_at_gh < $2::timestamptz) as merged_prs
`;

export const REPO_SQL = `
with ev as (
  select repo_full_name, event_type, action, actor_login, branch, payload
  from activity_events
  where occurred_at >= $1::timestamptz and occurred_at < $2::timestamptz
    and repo_full_name is not null
),
rc as (
  select r.full_name, count(*)::int as commits
  from commits c join repositories r on r.id = c.repository_id
  where c.occurred_at >= $1::timestamptz and c.occurred_at < $2::timestamptz
  group by r.full_name
),
ps as (
  select r.full_name,
         coalesce(sum(p.additions),0)::int as lines_added,
         coalesce(sum(p.deletions),0)::int as lines_removed,
         coalesce(sum(p.changed_files),0)::int as files_changed
  from pull_request_snapshots p join repositories r on r.id = p.repository_id
  where p.merged_at_gh >= $1::timestamptz and p.merged_at_gh < $2::timestamptz
  group by r.full_name
)
select
  ev.repo_full_name as full_name,
  coalesce(rc.commits, 0)::int as commits,
  count(*) filter (where ev.event_type = 'pull_request' and ev.action in ('opened','reopened'))::int as pull_requests_opened,
  count(*) filter (where ev.event_type = 'pull_request' and ev.action = 'closed'
      and coalesce((ev.payload->'pull_request'->>'merged')::boolean, (ev.payload->>'merged')::boolean, false))::int as pull_requests_merged,
  count(*) filter (where ev.event_type = 'release')::int as releases,
  count(*) filter (where ev.event_type = 'issues' and ev.action = 'opened')::int as issues_opened,
  count(*) filter (where ev.event_type = 'issues' and ev.action = 'closed')::int as issues_closed,
  count(distinct ev.actor_login)::int as contributors,
  count(distinct ev.branch)::int as branches,
  coalesce(ps.lines_added, 0)::int as lines_added,
  coalesce(ps.lines_removed, 0)::int as lines_removed,
  coalesce(ps.files_changed, 0)::int as files_changed
from ev
left join rc on rc.full_name = ev.repo_full_name
left join ps on ps.full_name = ev.repo_full_name
group by ev.repo_full_name, rc.commits, ps.lines_added, ps.lines_removed, ps.files_changed
order by commits desc, pull_requests_opened desc
`;

export const CONTRIBUTORS_SQL = `
with cm as (
  select author_login as login, count(*)::int as commits, count(distinct repository_id)::int as repos
  from commits
  where occurred_at >= $1::timestamptz and occurred_at < $2::timestamptz and author_login is not null
  group by author_login
),
pr as (
  select actor_login as login, count(*)::int as prs
  from activity_events
  where event_type = 'pull_request' and action in ('opened','reopened')
    and occurred_at >= $1::timestamptz and occurred_at < $2::timestamptz and actor_login is not null
  group by actor_login
)
select coalesce(cm.login, pr.login) as login,
       coalesce(cm.commits, 0)::int as commits,
       coalesce(cm.repos, 0)::int as repositories,
       coalesce(pr.prs, 0)::int as pull_requests
from cm full outer join pr on pr.login = cm.login
order by commits desc, pull_requests desc
limit $3
`;

export const DAILY_SQL = `
select occurred_at::date::text as date, count(*)::int as count
from commits
where occurred_at >= $1::timestamptz and occurred_at < $2::timestamptz
group by 1 order by 1
`;

export const NOTABLE_COMMITS_SQL = `
select r.full_name, c.sha, c.message, c.author_login, c.url
from commits c join repositories r on r.id = c.repository_id
where c.occurred_at >= $1::timestamptz and c.occurred_at < $2::timestamptz
order by c.occurred_at desc
limit 500
`;

export const NOTABLE_PRS_SQL = `
select ae.repo_full_name as full_name, ae.pr_number, ae.title, ae.action, ae.url,
       coalesce((ae.payload->'pull_request'->>'merged')::boolean, (ae.payload->>'merged')::boolean, false) as merged
from activity_events ae
where ae.event_type = 'pull_request' and ae.action in ('opened','reopened','closed')
  and ae.occurred_at >= $1::timestamptz and ae.occurred_at < $2::timestamptz
order by ae.occurred_at desc
limit 300
`;
