-- Retires app_state now that clients/posts/strategy_notes + real auth have
-- fully replaced it (verified working end-to-end: all three roles, and
-- real Facebook publishing). This table's RLS was the critical finding
-- from the security review -- "Allow public read/update" granted
-- unconditional access to anyone holding the (publicly hardcoded) anon
-- key, including the ability to overwrite adminUsernameOverride and
-- hijack admin access outright.
--
-- Renamed rather than dropped, as a cooling-off period -- keeps the data
-- around as a safety net in case anything was missed, without leaving the
-- dangerous public policies active. Drop the table outright in a later
-- migration once nothing has needed it for a while.
drop policy if exists "Allow public read" on app_state;
drop policy if exists "Allow public update" on app_state;
alter table app_state rename to app_state_deprecated_20260730;

-- Only ever existed to atomically patch one element inside app_state's
-- posts JSON array without racing the frontend's whole-blob overwrite --
-- posts is a real table now, so a plain UPDATE ... WHERE id = ... replaces
-- it entirely (see publish-scheduled-posts).
drop function if exists update_post_status(text, jsonb, text);
