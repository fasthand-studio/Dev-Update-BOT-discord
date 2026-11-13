-- Test fixture: real schema + representative seed data.
-- Used by tests/stats-sql.test.ts to validate the aggregation SQL.

create table if not exists repositories (
  id bigserial primary key,
  github_id bigint not null unique,
  installation_id bigint,
  owner_login text not null,
  name text not null,
  full_name text not null unique,
  private boolean not null default false,
  archived boolean not null default false,
  disabled boolean not null default false,
  default_branch text,
  html_url text,
  description text,
  pushed_at timestamptz,
  active boolean not null default true,
  discovered_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists activity_events (
  id bigserial primary key,
  source text not null default 'github',
  event_type text not null,
  action text,
  delivery_id text,
  external_id text,
  repository_id bigint references repositories(id) on delete set null,
  repo_full_name text,
  contributor_id bigint,
  actor_login text,
  ref text,
  branch text,
  commit_count integer,
  pr_number integer,
  issue_number integer,
  release_tag text,
  title text,
  summary text,
  url text,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  notified_at timestamptz,
  notify_error text
);

create table if not exists commits (
  id bigserial primary key,
  repository_id bigint not null references repositories(id) on delete cascade,
  sha text not null,
  message text,
  author_login text,
  author_name text,
  author_email text,
  committer_login text,
  url text,
  branch text,
  occurred_at timestamptz,
  push_event_id bigint references activity_events(id) on delete set null,
  created_at timestamptz not null default now(),
  unique(repository_id, sha)
);

create table if not exists pull_request_snapshots (
  repository_id bigint not null references repositories(id) on delete cascade,
  pr_number integer not null,
  github_id bigint,
  title text,
  state text,
  draft boolean default false,
  merged boolean default false,
  author_login text,
  html_url text,
  base_ref text,
  head_ref text,
  created_at_gh timestamptz,
  updated_at_gh timestamptz,
  closed_at_gh timestamptz,
  merged_at_gh timestamptz,
  additions integer,
  deletions integer,
  changed_files integer,
  updated_at timestamptz not null default now(),
  primary key (repository_id, pr_number)
);

create table if not exists weekly_reports (
  id bigserial primary key,
  week_start date not null unique,
  week_end date not null,
  stats jsonb not null,
  ai_summary text,
  heatmap_png_base64 text,
  discord_message_id text,
  created_at timestamptz not null default now()
);
