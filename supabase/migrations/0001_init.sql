-- GitHub Activity Discord Bot schema
-- Apply with Supabase SQL editor or CLI (supabase db push / migration tooling).

create extension if not exists pgcrypto;

create table if not exists github_installations (
  id bigint primary key, -- GitHub installation id
  account_login text not null,
  account_type text not null,
  account_id bigint,
  repositories_selection text, -- all / selected
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists repositories (
  id bigserial primary key,
  github_id bigint not null unique,
  installation_id bigint references github_installations(id) on delete set null,
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
create index if not exists repositories_installation_idx on repositories(installation_id);
create index if not exists repositories_full_name_idx on repositories(full_name);

create table if not exists contributors (
  id bigserial primary key,
  github_id bigint unique,
  login text not null unique,
  name text,
  email text,
  avatar_url text,
  html_url text,
  type text, -- User/Bot
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists contributors_login_idx on contributors(login);

create table if not exists webhook_deliveries (
  delivery_id text primary key,
  source text not null, -- github, discord, cron
  event_type text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  status text not null default 'received', -- received, processed, ignored, failed
  error text
);

create table if not exists activity_events (
  id bigserial primary key,
  source text not null default 'github',
  event_type text not null, -- push, pull_request, release, issues, ping, installation_repositories, etc.
  action text, -- opened, closed, merged, synchronize, created, published...
  delivery_id text references webhook_deliveries(delivery_id) on delete set null,
  external_id text, -- optional stable id for extra dedup (e.g. release id, issue comment id)
  repository_id bigint references repositories(id) on delete set null,
  repo_full_name text,
  contributor_id bigint references contributors(id) on delete set null,
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
create index if not exists activity_events_repo_time_idx on activity_events(repository_id, occurred_at desc);
create index if not exists activity_events_type_time_idx on activity_events(event_type, occurred_at desc);
create index if not exists activity_events_actor_time_idx on activity_events(actor_login, occurred_at desc);
create index if not exists activity_events_delivery_idx on activity_events(delivery_id);
create unique index if not exists activity_events_external_uidx on activity_events(source, event_type, external_id) where external_id is not null;

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
create index if not exists commits_repo_time_idx on commits(repository_id, occurred_at desc);
create index if not exists commits_author_time_idx on commits(author_login, occurred_at desc);

create table if not exists pull_request_snapshots (
  repository_id bigint not null references repositories(id) on delete cascade,
  pr_number integer not null,
  github_id bigint,
  title text,
  state text, -- open/closed
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
  week_start date not null unique, -- Monday UTC
  week_end date not null,
  stats jsonb not null,
  ai_summary text,
  heatmap_png_base64 text, -- optional small cache/debug; Discord gets attachment
  discord_message_id text,
  created_at timestamptz not null default now()
);

-- updated_at trigger helper
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists repositories_set_updated_at on repositories;
create trigger repositories_set_updated_at before update on repositories
for each row execute function set_updated_at();

drop trigger if exists github_installations_set_updated_at on github_installations;
create trigger github_installations_set_updated_at before update on github_installations
for each row execute function set_updated_at();
