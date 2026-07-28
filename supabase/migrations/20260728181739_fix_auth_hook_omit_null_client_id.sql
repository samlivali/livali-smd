-- Third and final bug: GoTrue's own claims-schema validation rejects a
-- present `client_id` key whose value is JSON null ("Expected: string,
-- given: null") -- it must be either a real string or absent entirely.
-- Admin/editor profiles legitimately have no client_id, so omit the key
-- for them instead of including it as null. RLS policies already read this
-- with auth.jwt()->>'client_id', which returns SQL NULL for a missing key
-- exactly the same as for a present-but-null one, so no policy changes
-- needed.
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
    claims := claims || jsonb_build_object('user_role', prof.role);
    if prof.client_id is not null then
      claims := claims || jsonb_build_object('client_id', prof.client_id);
    end if;
  end if;
  return jsonb_set(event, '{claims}', claims);
end;
$$;
