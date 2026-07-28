-- Root cause of claims never appearing: for a composite/record value, SQL's
-- "IS NOT NULL" is true only if EVERY field is non-null -- since client_id
-- is legitimately NULL for admin/editor profiles, `prof IS NOT NULL` always
-- evaluated false for them even though the row was found (confirmed via
-- direct SQL: prof.role = 'admin', prof IS NULL = false, but prof IS NOT
-- NULL is *also* false because client_id is null -- classic row-type
-- asymmetry, not the logical negation you'd expect). Use FOUND instead,
-- which reflects whether the SELECT INTO actually matched a row.
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  claims jsonb := event -> 'claims';
  prof record;
begin
  select role, client_id into prof from public.profiles where id = (event ->> 'user_id')::uuid;
  if found then
    claims := jsonb_set(claims, '{user_role}', to_jsonb(prof.role));
    claims := jsonb_set(claims, '{client_id}', to_jsonb(prof.client_id));
  end if;
  return jsonb_set(event, '{claims}', claims);
end;
$$;
