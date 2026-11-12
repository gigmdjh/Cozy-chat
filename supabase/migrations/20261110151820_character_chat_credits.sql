create table if not exists public.user_credits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  balance integer not null default 100 check (balance >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.credit_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  delta integer not null,
  balance_after integer not null,
  kind text not null check (kind in ('usage','refund','grant')),
  model text,
  request_id uuid not null,
  created_at timestamptz not null default now(),
  unique (request_id, kind)
);

alter table public.user_credits enable row level security;
alter table public.credit_transactions enable row level security;
revoke all on public.user_credits from anon, authenticated;
revoke all on public.credit_transactions from anon, authenticated;
grant select on public.user_credits to authenticated;
grant select on public.credit_transactions to authenticated;
drop policy if exists "Users can view their own credit balance" on public.user_credits;
create policy "Users can view their own credit balance" on public.user_credits
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "Users can view their own credit transactions" on public.credit_transactions;
create policy "Users can view their own credit transactions" on public.credit_transactions
  for select to authenticated using ((select auth.uid()) = user_id);

create or replace function public.change_user_credits(
  p_user_id uuid,
  p_delta integer,
  p_model text,
  p_request_id uuid
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_balance integer;
  v_kind text;
begin
  if p_delta = 0 or abs(p_delta) > 10000 then
    raise exception 'INVALID_CREDIT_DELTA';
  end if;
  v_kind := case when p_delta < 0 then 'usage' else 'refund' end;

  insert into public.user_credits(user_id, balance)
  values (p_user_id, 100)
  on conflict (user_id) do nothing;

  if exists (
    select 1 from public.credit_transactions
    where request_id = p_request_id and kind = v_kind
  ) then
    select balance into v_balance from public.user_credits where user_id = p_user_id;
    return v_balance;
  end if;

  if p_delta < 0 then
    update public.user_credits
      set balance = balance + p_delta, updated_at = now()
      where user_id = p_user_id and balance >= abs(p_delta)
      returning balance into v_balance;
    if v_balance is null then
      raise exception 'INSUFFICIENT_CREDITS';
    end if;
  else
    update public.user_credits
      set balance = balance + p_delta, updated_at = now()
      where user_id = p_user_id
      returning balance into v_balance;
  end if;

  insert into public.credit_transactions(user_id, delta, balance_after, kind, model, request_id)
  values (p_user_id, p_delta, v_balance, v_kind, p_model, p_request_id);

  return v_balance;
end;
$$;

revoke all on function public.change_user_credits(uuid, integer, text, uuid) from public, anon, authenticated;
grant execute on function public.change_user_credits(uuid, integer, text, uuid) to service_role;
