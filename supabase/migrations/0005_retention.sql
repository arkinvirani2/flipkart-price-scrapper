-- 0005_retention.sql — keep the newest 30 batches per account.
--
-- Apply this LAST, and only once you are happy the rest works: it is the only
-- migration that deletes anything.
--
-- What it deletes: jobs beyond the newest 30 for an account, ordered by
-- created_at, and by cascade their inputs, results and recommendations.
--
-- What it never touches: fsn_intelligence and intelligence_processed_jobs.
-- That is the whole point of those two tables having no foreign key to jobs.
-- Before this migration existed, the intelligence store could be thrown away
-- and rebuilt by replaying every job folder on disk. Once batches are being
-- pruned that replay is lossy, so the learning has to be authoritative in its
-- own right and outlive the batch it came from.

create or replace function public.prune_jobs(p_keep integer default 30)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_count integer;
begin
  with ranked as (
    select id,
           row_number() over (partition by account_name order by created_at desc) as rn
      from public.jobs
     -- Never prune work that is queued or in flight. A batch waiting for the
     -- next worker has not run yet; deleting it would silently drop an upload.
     where state not in ('queued', 'running', 'pausing', 'stopping')
  )
  delete from public.jobs j
   using ranked
   where j.id = ranked.id
     and ranked.rn > p_keep;

  get diagnostics v_count = row_count;
  return v_count;
end;
$fn$;

revoke execute on function public.prune_jobs(integer) from anon, authenticated, public;

-- ───────────────────────────────────────────────────────────────── schedule
--
-- pg_cron runs inside the database, so retention does not depend on the
-- dashboard being visited or the workflow firing. Times are UTC.
-- 19:00 UTC = 00:30 IST, i.e. after both daily batches have finished.
--
-- The whole block is guarded, including the CREATE EXTENSION: enabling pg_cron
-- is a privileged operation, and on a project where it is not available this
-- must degrade to a notice rather than abort the migration and leave
-- prune_jobs() defined but the rest of the file unapplied.
--
-- If the notice appears, either enable pg_cron from the Supabase dashboard
-- (Database → Extensions) and re-run this file, or run
-- `select public.prune_jobs(30);` by hand from the SQL editor now and then.
-- Nothing else depends on it — retention is a tidy-up, not a correctness rule.

do $do$
begin
  create extension if not exists pg_cron;

  perform cron.unschedule('prune-jobs')
    where exists (select 1 from cron.job where jobname = 'prune-jobs');

  perform cron.schedule('prune-jobs', '0 19 * * *', $cron$select public.prune_jobs(30);$cron$);

  raise notice 'prune_jobs(30) scheduled daily at 19:00 UTC (00:30 IST).';
exception
  when others then
    raise notice 'pg_cron not available (%). Run select public.prune_jobs(30); yourself — see the comment above.', sqlerrm;
end
$do$;
