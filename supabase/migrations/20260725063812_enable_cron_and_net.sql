-- Needed to run publish-scheduled-posts on a schedule: pg_cron fires the
-- job, pg_net makes the HTTP call to the Edge Function. The job itself
-- (and the secret it authenticates with) is set up separately via Vault,
-- not in a checked-in migration, so the secret never lands in git history.
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;
