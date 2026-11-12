-- ===== 사용자 설정: 약관 동의 · 언세이프 보기 =====
create table if not exists public.user_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  show_unsafe boolean not null default false,
  adult_confirmed_at timestamptz,
  terms_version text,
  terms_agreed_at timestamptz,
  updated_at timestamptz not null default now(),
  check (not show_unsafe or adult_confirmed_at is not null)
);
alter table public.user_preferences enable row level security;
revoke all on public.user_preferences from anon, authenticated;
grant select, insert, update on public.user_preferences to authenticated;
create policy "Users read own preferences" on public.user_preferences for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "Users add own preferences" on public.user_preferences for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "Users update own preferences" on public.user_preferences for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- ===== 캐릭터 등급 (세이프 / 언세이프) =====
alter table public.public_characters add column if not exists rating text not null default 'safe';
alter table public.public_characters drop constraint if exists public_characters_rating_check;
alter table public.public_characters add constraint public_characters_rating_check check (rating in ('safe','unsafe'));
update public.public_characters set rating = 'unsafe' where character_data->>'rating' = 'unsafe' and rating <> 'unsafe';

-- 언세이프는 성인 확인 후 스위치를 켠 로그인 사용자(와 제작자 본인)에게만 내려간다
drop policy if exists "Public characters are viewable" on public.public_characters;
create policy "Public characters are viewable" on public.public_characters
  for select to anon, authenticated
  using (
    (visibility in ('public','unlisted') and not hidden and (
      rating = 'safe'
      or exists (select 1 from public.user_preferences p where p.user_id = (select auth.uid()) and p.show_unsafe)
    ))
    or (select auth.uid()) = user_id
  );

-- ===== 결제 대비: 상품 · 주문 · 지급 함수 (결제 연결 전까지는 쓰이지 않음) =====
create table if not exists public.cookie_packages (
  id text primary key,
  cookies integer not null check (cookies > 0),
  bonus integer not null default 0 check (bonus >= 0),
  price_krw integer not null check (price_krw > 0),
  active boolean not null default true,
  sort integer not null default 0
);
alter table public.cookie_packages enable row level security;
revoke all on public.cookie_packages from anon, authenticated;
grant select on public.cookie_packages to anon, authenticated;
create policy "Anyone can read active packages" on public.cookie_packages for select to anon, authenticated using (active);
insert into public.cookie_packages (id, cookies, bonus, price_krw, sort) values
  ('cookie_3000', 3000, 0, 3000, 1),
  ('cookie_10000', 10000, 1000, 10000, 2),
  ('cookie_30000', 30000, 4500, 30000, 3),
  ('cookie_50000', 50000, 10000, 50000, 4)
on conflict (id) do nothing;

create table if not exists public.cookie_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  package_id text not null references public.cookie_packages(id),
  cookies integer not null check (cookies > 0),
  amount_krw integer not null check (amount_krw > 0),
  status text not null default 'pending' check (status in ('pending','paid','failed','canceled','refunded')),
  provider text,
  provider_payment_key text unique,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create index if not exists cookie_orders_user_idx on public.cookie_orders (user_id);
create index if not exists cookie_orders_package_idx on public.cookie_orders (package_id);
alter table public.cookie_orders enable row level security;
revoke all on public.cookie_orders from anon, authenticated;
grant select on public.cookie_orders to authenticated;
create policy "Users see own orders" on public.cookie_orders for select to authenticated
  using ((select auth.uid()) = user_id);

alter table public.credit_transactions drop constraint if exists credit_transactions_kind_check;
alter table public.credit_transactions add constraint credit_transactions_kind_check
  check (kind in ('usage','refund','grant','purchase'));

-- 결제 승인 후 서버(service role)만 호출. 같은 주문을 두 번 처리해도 한 번만 지급된다.
create or replace function public.grant_purchased_cookies(p_order_id uuid, p_provider text, p_payment_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_order public.cookie_orders%rowtype; v_balance int;
begin
  select * into v_order from public.cookie_orders where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if v_order.status = 'paid' then
    select balance into v_balance from public.user_credits where user_id = v_order.user_id;
    return jsonb_build_object('granted', false, 'balance', v_balance);
  end if;
  if v_order.status <> 'pending' then raise exception 'ORDER_NOT_PENDING'; end if;
  update public.cookie_orders set status = 'paid', paid_at = now(), provider = p_provider, provider_payment_key = p_payment_key
   where id = p_order_id;
  insert into public.user_credits(user_id, balance) values (v_order.user_id, 1000) on conflict (user_id) do nothing;
  update public.user_credits set balance = balance + v_order.cookies, updated_at = now()
   where user_id = v_order.user_id returning balance into v_balance;
  insert into public.credit_transactions(user_id, delta, balance_after, kind, model, request_id)
  values (v_order.user_id, v_order.cookies, v_balance, 'purchase', v_order.package_id, p_order_id);
  return jsonb_build_object('granted', true, 'balance', v_balance);
end; $$;
revoke all on function public.grant_purchased_cookies(uuid, text, text) from public, anon, authenticated;
grant execute on function public.grant_purchased_cookies(uuid, text, text) to service_role;
