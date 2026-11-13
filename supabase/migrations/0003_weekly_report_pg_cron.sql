-- Weekly report scheduler using Supabase pg_cron + pg_net.
-- Apply manually in the Supabase SQL editor (Database -> SQL Editor), after:
--   1. Enabling extensions: Database -> Extensions -> pg_cron, pg_net.
--   2. Storing the Vercel CRON_SECRET in Vault:
--        select vault.create_secret('<YOUR_CRON_SECRET>', 'fastydiscord_cron_secret');
--      (use vault.update_secret if it already exists)
--
-- This mirrors the FastHand Status-Page scheduler pattern. pg_cron fires at the
-- exact minute (unlike Vercel Cron on Hobby, which jitters within the hour).
-- The job calls the production deployment's /api/cron/weekly endpoint. Dedup in
-- the handler (weekly_reports.week_start) prevents duplicate posts if both this
-- and the Vercel Cron happen to fire in the same hour.

select cron.schedule(
  'fastydiscord-weekly-report',
  '5 7 * * 5',  -- Friday 07:05 UTC = Friday 13:05 Bangladesh time
  $$
  select net.http_post(
    url := 'https://fastydiscord.vercel.app/api/cron/weekly',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets
        where name = 'fastydiscord_cron_secret'
      )
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

-- Inspect / manage:
--   select jobid, jobname, command from cron.job where jobname = 'fastydiscord-weekly-report';
--   select start_time, status, return_message from cron.job_run_details
--     where jobname = 'fastydiscord-weekly-report' order by start_time desc limit 5;
--   select cron.unschedule('fastydiscord-weekly-report');
