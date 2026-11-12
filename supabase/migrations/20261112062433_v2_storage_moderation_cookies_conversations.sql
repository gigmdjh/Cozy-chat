-- ===== 1) 이미지 저장소 =====
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('cozy-images', 'cozy-images', true, 8388608, array['image/jpeg','image/png','image/webp','image/gif'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "cozy images: owner upload" on storage.objects;
create policy "cozy images: owner upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'cozy-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "cozy images: owner update" on storage.objects;
create policy "cozy images: owner update" on storage.objects for update to authenticated
  using (bucket_id = 'cozy-images' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'cozy-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "cozy images: owner delete" on storage.objects;
create policy "cozy images: owner delete" on storage.objects for delete to authenticated
  using (bucket_id = 'cozy-images' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- ===== 2) 신고 · 숨김 · 차단 · 글 삭제 =====
alter table public.community_posts add column if not exists hidden boolean not null default false;
alter table public.public_characters add column if not exists hidden boolean not null default false;

drop policy if exists "Anyone can read community posts" on public.community_posts;
create policy "Anyone can read community posts" on public.community_posts
  for select to anon, authenticated using (not hidden or (select auth.uid()) = user_id);
drop policy if exists "Users can delete own community posts" on public.community_posts;
create policy "Users can delete own community posts" on public.community_posts
  for delete to authenticated using ((select auth.uid()) = user_id);
grant delete on public.community_posts to authenticated;

drop policy if exists "Public characters are viewable" on public.public_characters;
create policy "Public characters are viewable" on public.public_characters
  for select to anon, authenticated
  using ((visibility in ('public','unlisted') and not hidden) or (select auth.uid()) = user_id);

create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users(id) on delete cascade,
  target_type text not null check (target_type in ('character','post','user')),
  target_owner_id uuid not null references auth.users(id) on delete cascade,
  target_id text not null check (length(target_id) between 1 and 200),
  reason text not null check (char_length(reason) between 1 and 500),
  status text not null default 'open' check (status in ('open','resolved','dismissed')),
  created_at timestamptz not null default now(),
  unique (reporter_id, target_type, target_owner_id, target_id),
  check (reporter_id <> target_owner_id)
);
create index if not exists reports_target_idx on public.reports (target_type, target_owner_id, target_id);
create index if not exists reports_owner_idx on public.reports (target_owner_id);
alter table public.reports enable row level security;
revoke all on public.reports from anon, authenticated;
grant select, insert on public.reports to authenticated;
create policy "Users can file reports" on public.reports for insert to authenticated
  with check ((select auth.uid()) = reporter_id and status = 'open');
create policy "Users can see own reports" on public.reports for select to authenticated
  using ((select auth.uid()) = reporter_id);

-- 서로 다른 3명이 신고하면 자동 숨김 (대시보드에서 hidden=false 로 복구 가능)
create or replace function public.auto_hide_reported()
returns trigger language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  select count(distinct reporter_id) into n from public.reports
   where target_type = new.target_type and target_owner_id = new.target_owner_id
     and target_id = new.target_id and status = 'open';
  if n >= 3 then
    if new.target_type = 'post' then
      update public.community_posts set hidden = true
       where id::text = new.target_id and user_id = new.target_owner_id;
    elsif new.target_type = 'character' then
      update public.public_characters set hidden = true
       where character_id = new.target_id and user_id = new.target_owner_id;
    end if;
  end if;
  return new;
end; $$;
revoke execute on function public.auto_hide_reported() from public, anon, authenticated;
drop trigger if exists reports_auto_hide on public.reports;
create trigger reports_auto_hide after insert on public.reports
  for each row execute function public.auto_hide_reported();

create table if not exists public.user_blocks (
  blocker_id uuid not null references auth.users(id) on delete cascade,
  blocked_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index if not exists user_blocks_blocked_idx on public.user_blocks (blocked_id);
alter table public.user_blocks enable row level security;
revoke all on public.user_blocks from anon, authenticated;
grant select, insert, delete on public.user_blocks to authenticated;
create policy "Users manage own blocks: read" on public.user_blocks for select to authenticated
  using ((select auth.uid()) = blocker_id);
create policy "Users manage own blocks: add" on public.user_blocks for insert to authenticated
  with check ((select auth.uid()) = blocker_id);
create policy "Users manage own blocks: remove" on public.user_blocks for delete to authenticated
  using ((select auth.uid()) = blocker_id);

-- ===== 3) 쿠키 출석 보상 =====
create table if not exists public.daily_rewards (
  user_id uuid not null references auth.users(id) on delete cascade,
  reward_date date not null,
  amount integer not null check (amount > 0),
  created_at timestamptz not null default now(),
  primary key (user_id, reward_date)
);
alter table public.daily_rewards enable row level security;
revoke all on public.daily_rewards from anon, authenticated;
grant select on public.daily_rewards to authenticated;
create policy "Users can see own daily rewards" on public.daily_rewards for select to authenticated
  using ((select auth.uid()) = user_id);

create or replace function public.claim_daily_cookies(p_user_id uuid, p_amount integer default 20)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_today date := (now() at time zone 'Asia/Seoul')::date;
  v_inserted int;
  v_balance int;
begin
  insert into public.user_credits(user_id, balance) values (p_user_id, 100)
  on conflict (user_id) do nothing;
  insert into public.daily_rewards(user_id, reward_date, amount) values (p_user_id, v_today, p_amount)
  on conflict do nothing;
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

-- ===== 4) 대화방 단위 기록 + 장기 기억 =====
create table if not exists public.conversations (
  user_id uuid not null references auth.users(id) on delete cascade,
  character_key text not null check (length(character_key) between 1 and 300),
  messages jsonb not null default '[]'::jsonb,
  memory text not null default '',
  memory_until bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, character_key)
);
alter table public.conversations enable row level security;
revoke all on public.conversations from anon, authenticated;
grant select, insert, update, delete on public.conversations to authenticated;
create policy "Users read own conversations" on public.conversations for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "Users add own conversations" on public.conversations for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "Users update own conversations" on public.conversations for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users delete own conversations" on public.conversations for delete to authenticated
  using ((select auth.uid()) = user_id);

-- 기존 한 덩어리 기록을 대화방별로 옮김 (chat_histories 는 이전 버전 호환용으로 남김)
insert into public.conversations (user_id, character_key, messages, updated_at)
select h.user_id, e.key, e.value, h.updated_at
from public.chat_histories h, jsonb_each(h.histories) e
where jsonb_typeof(e.value) = 'array'
on conflict (user_id, character_key) do nothing;
