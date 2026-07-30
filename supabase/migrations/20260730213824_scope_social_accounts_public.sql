-- social_accounts_public had no row-level scoping at all -- any
-- authenticated user could read every client's connection status via the
-- REST API directly, regardless of what any particular UI happened to
-- show. Not exploitable through the app today (admin/editor already see
-- everything by design, and there's only one real client), but it's a
-- real gap in the view itself, found while building the Social Accounts
-- tab. Same predicate shape as clients_select.
drop view if exists social_accounts_public;
create view social_accounts_public as
  select client_id, platform, page_name, connected_at
  from social_accounts
  where (auth.jwt() ->> 'user_role') in ('admin', 'editor')
        or client_id = (auth.jwt() ->> 'client_id');

-- Must run as the view owner (bypassing social_accounts' own RLS, which has
-- zero policies for anon/authenticated) -- the WHERE clause above is what
-- actually governs access, evaluated fresh per-request against auth.jwt().
alter view social_accounts_public set (security_invoker = false);
grant select on social_accounts_public to authenticated;
