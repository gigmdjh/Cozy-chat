-- 대시보드 SQL Editor에서 직접 만든 테이블들을 기록한 기준 스키마.
-- 원격 DB에는 이미 적용되어 있으므로, CLI로 연결할 때는
--   supabase migration repair --status applied 20261101000000
-- 로 적용 완료 표시만 해 주세요. (모든 문장은 재실행해도 안전하게 작성됨)

create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 30),
  bio text not null default '' check (char_length(bio) <= 240),
  avatar_data text,
  updated_at timestamptz not null default now()
);

create table if not exists public.user_characters (
  user_id uuid primary key references auth.users(id) on delete cascade,
  characters jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.chat_histories (
  user_id uuid primary key references auth.users(id) on delete cascade,
  histories jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.community_posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  content text not null check (char_length(trim(content)) between 1 and 600),
  author_name text not null default '사용자',
  created_at timestamptz not null default now()
);

create table if not exists public.follows (
  follower_id uuid not null references auth.users(id) on delete cascade,
  following_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, following_id),
  check (follower_id <> following_id)
);

alter table public.user_profiles enable row level security;
alter table public.user_characters enable row level security;
alter table public.chat_histories enable row level security;
alter table public.community_posts enable row level security;
alter table public.follows enable row level security;

-- user_profiles
drop policy if exists "Public profiles are viewable by everyone" on public.user_profiles;
create policy "Public profiles are viewable by everyone" on public.user_profiles
  for select to anon, authenticated using (true);
drop policy if exists "Users can insert own profile" on public.user_profiles;
create policy "Users can insert own profile" on public.user_profiles
  for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "Users can update own profile" on public.user_profiles;
create policy "Users can update own profile" on public.user_profiles
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- user_characters
drop policy if exists "Users can read own characters" on public.user_characters;
create policy "Users can read own characters" on public.user_characters
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "Users can insert own characters" on public.user_characters;
create policy "Users can insert own characters" on public.user_characters
  for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "Users can update own characters" on public.user_characters;
create policy "Users can update own characters" on public.user_characters
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- chat_histories
drop policy if exists "Users can read own chat history" on public.chat_histories;
create policy "Users can read own chat history" on public.chat_histories
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "Users can insert own chat history" on public.chat_histories;
create policy "Users can insert own chat history" on public.chat_histories
  for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "Users can update own chat history" on public.chat_histories;
create policy "Users can update own chat history" on public.chat_histories
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- community_posts
drop policy if exists "Anyone can read community posts" on public.community_posts;
create policy "Anyone can read community posts" on public.community_posts
  for select to anon, authenticated using (true);
drop policy if exists "Users can insert own community posts" on public.community_posts;
create policy "Users can insert own community posts" on public.community_posts
  for insert to authenticated with check ((select auth.uid()) = user_id);

-- follows
drop policy if exists "Users can read follow relations" on public.follows;
create policy "Users can read follow relations" on public.follows
  for select to anon, authenticated using (true);
drop policy if exists "Users can follow as themselves" on public.follows;
create policy "Users can follow as themselves" on public.follows
  for insert to authenticated
  with check ((select auth.uid()) = follower_id and follower_id <> following_id);
drop policy if exists "Users can unfollow as themselves" on public.follows;
create policy "Users can unfollow as themselves" on public.follows
  for delete to authenticated using ((select auth.uid()) = follower_id);
