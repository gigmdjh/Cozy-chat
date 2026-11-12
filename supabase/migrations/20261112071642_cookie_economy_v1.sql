-- 쿠키 1개 ≈ ₩1 기준: 가입 선물 1,000쿠키
alter table public.user_credits alter column balance set default 1000;

create or replace function public.get_or_create_user_credits(p_user_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_balance integer;
begin
  insert into public.user_credits(user_id, balance) values (p_user_id, 1000)
  on conflict (user_id) do nothing;
  select balance into v_balance from public.user_credits where user_id = p_user_id;
  return v_balance;
end; $$;
revoke all on function public.get_or_create_user_credits(uuid) from public, anon, authenticated;
grant execute on function public.get_or_create_user_credits(uuid) to service_role;

create or replace function public.change_user_credits(p_user_id uuid, p_delta integer, p_model text, p_request_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_balance integer; v_kind text;
begin
  if p_delta = 0 or abs(p_delta) > 10000 then raise exception 'INVALID_CREDIT_DELTA'; end if;
  v_kind := case when p_delta < 0 then 'usage' else 'refund' end;
  insert into public.user_credits(user_id, balance) values (p_user_id, 1000)
  on conflict (user_id) do nothing;
  if exists (select 1 from public.credit_transactions where request_id = p_request_id and kind = v_kind) then
    select balance into v_balance from public.user_credits where user_id = p_user_id;
    return v_balance;
  end if;
  if p_delta < 0 then
    update public.user_credits set balance = balance + p_delta, updated_at = now()
     where user_id = p_user_id and balance >= abs(p_delta) returning balance into v_balance;
    if v_balance is null then raise exception 'INSUFFICIENT_CREDITS'; end if;
  else
    update public.user_credits set balance = balance + p_delta, updated_at = now()
     where user_id = p_user_id returning balance into v_balance;
  end if;
  insert into public.credit_transactions(user_id, delta, balance_after, kind, model, request_id)
  values (p_user_id, p_delta, v_balance, v_kind, p_model, p_request_id);
  return v_balance;
end; $$;
revoke all on function public.change_user_credits(uuid, integer, text, uuid) from public, anon, authenticated;
grant execute on function public.change_user_credits(uuid, integer, text, uuid) to service_role;

create or replace function public.claim_daily_cookies(p_user_id uuid, p_amount integer default 100)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_today date := (now() at time zone 'Asia/Seoul')::date; v_inserted int; v_balance int;
begin
  insert into public.user_credits(user_id, balance) values (p_user_id, 1000) on conflict (user_id) do nothing;
  insert into public.daily_rewards(user_id, reward_date, amount) values (p_user_id, v_today, p_amount) on conflict do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    select balance into v_balance from public.user_credits where user_id = p_user_id;
    return jsonb_build_object('claimed', false, 'balance', v_balance, 'amount', 0);
  end if;
  update public.user_credits set balance = balance + p_amount, updated_at = now()
   where user_id = p_user_id returning balance into v_balance;
  insert into public.credit_transactions(user_id, delta, balance_after, kind, model, request_id)
  values (p_user_id, p_amount, v_balance, 'grant', 'daily', gen_random_uuid());
  return jsonb_build_object('claimed', true, 'balance', v_balance, 'amount', p_amount);
end; $$;
revoke all on function public.claim_daily_cookies(uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_daily_cookies(uuid, integer) to service_role;

-- 기존 가입자도 새 가입 선물(1,000)에 맞춰 900쿠키 추가 지급
with bumped as (
  update public.user_credits set balance = balance + 900, updated_at = now() returning user_id, balance
)
insert into public.credit_transactions(user_id, delta, balance_after, kind, model, request_id)
select user_id, 900, balance, 'grant', 'signup_bonus', gen_random_uuid() from bumped;
