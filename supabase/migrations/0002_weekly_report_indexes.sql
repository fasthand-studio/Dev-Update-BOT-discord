-- Weekly report aggregation indexes.
-- Apply with Supabase SQL editor or CLI (supabase db push / migration tooling).
-- The weekly report filters heavily on occurred_at ranges; the existing composite
-- indexes lead with repository_id / event_type / actor_login and cannot serve a
-- bare occurred_at range scan.

create index if not exists activity_events_occurred_at_idx on activity_events(occurred_at desc);
create index if not exists commits_occurred_at_idx on commits(occurred_at desc);
create index if not exists activity_events_repo_occurred_idx on activity_events(repo_full_name, occurred_at desc);
