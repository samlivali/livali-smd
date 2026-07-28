-- Second bug in the same function: jsonb_set(target, path, new_value)
-- returns SQL NULL for the *entire* result when new_value itself is SQL
-- NULL (not a JSON null) -- and to_jsonb(prof.client_id) is exactly that
-- for admin/editor profiles, where client_id is legitimately NULL. That
-- NULL then propagated all the way out, so GoTrue received `claims: null`
-- and rejected the whole token ("output claims do not conform to expected
-- schema"). jsonb_build_object() correctly turns a NULL argument into a
-- JSON null instead of propagating, so build the update with it instead.
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
    claims := claims || jsonb_build_object('user_role', prof.role, 'client_id', prof.client_id);
  end if;
  return jsonb_set(event, '{claims}', claims);
end;
$$;
