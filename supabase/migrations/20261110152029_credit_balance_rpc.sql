create or replace function public.get_or_create_user_credits(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_balance integer;
begin
  insert into public.user_credits(user_id, balance)
  values (p_user_id, 100)
  on conflict (user_id) do nothing;

  select balance into v_balance
  from public.user_credits
  where user_id = p_user_id;

  return v_balance;
end;
$$;
revoke all on function public.get_or_create_user_credits(uuid) from public, anon, authenticated;
grant execute on function public.get_or_create_user_credits(uuid) to service_role;
