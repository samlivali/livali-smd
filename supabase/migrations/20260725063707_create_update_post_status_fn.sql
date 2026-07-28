-- Atomically patches one post's statuses/checkedAt inside the app_state
-- singleton row's posts JSON array, by post id. The frontend already does a
-- full-blob read-modify-write on every save (scheduleSave -> saveAppState);
-- a naive read-modify-write from the cron publisher would risk racing that
-- and clobbering a concurrent edit. Doing it as a single UPDATE statement
-- means Postgres's row lock makes the read-then-write atomic instead.
--
-- service_role only: the publish-scheduled-posts Edge Function is the only
-- intended caller, never the anon-keyed frontend.
create or replace function update_post_status(
  p_post_id text,
  p_statuses jsonb,
  p_checked_at text
) returns boolean
language sql
as $$
  update app_state
  set data = jsonb_set(
    data,
    array['posts', (idx.ordinality - 1)::text],
    (data -> 'posts' -> (idx.ordinality - 1)::int)
      || jsonb_build_object('statuses', p_statuses, 'checkedAt', p_checked_at)
  )
  from (
    select ordinality
    from jsonb_array_elements(
      (select data -> 'posts' from app_state where id = 'singleton')
    ) with ordinality as t(value, ordinality)
    where t.value ->> 'id' = p_post_id
    limit 1
  ) as idx
  where app_state.id = 'singleton'
  returning true;
$$;

revoke all on function update_post_status(text, jsonb, text) from public;
grant execute on function update_post_status(text, jsonb, text) to service_role;
