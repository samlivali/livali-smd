-- custom_access_token_hook runs as supabase_auth_admin, which has neither a
-- direct GRANT on public.profiles nor a way past its RLS policies. Recreate
-- it as SECURITY DEFINER so it runs with the (table-owning) function
-- creator's privileges instead, which is the standard fix for Auth Hooks
-- that need to read app tables. Belt-and-suspenders: also grant SELECT to
-- supabase_auth_admin directly in case a future edit drops SECURITY DEFINER.
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
  if prof is not null then
    claims := jsonb_set(claims, '{user_role}', to_jsonb(prof.role));
    claims := jsonb_set(claims, '{client_id}', to_jsonb(prof.client_id));
  end if;
  return jsonb_set(event, '{claims}', claims);
end;
$$;

grant select on public.profiles to supabase_auth_admin;
