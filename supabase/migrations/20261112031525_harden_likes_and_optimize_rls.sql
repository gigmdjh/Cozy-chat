-- 1) 좋아요: 누가 눌렀는지 공개하지 않고, 개수만 공개 테이블로 유지
drop policy if exists "Anyone can read character like targets" on public.character_likes;

drop view if exists public.character_like_counts;
create table public.character_like_counts (
  character_owner_id uuid not null,
  character_id text not null,
  like_count integer not null default 0 check (like_count >= 0),
  primary key (character_owner_id, character_id)
);
insert into public.character_like_counts (character_owner_id, character_id, like_count)
select character_owner_id, character_id, count(*)::int
from public.character_likes group by 1, 2;

alter table public.character_like_counts enable row level security;
revoke all on public.character_like_counts from anon, authenticated;
grant select on public.character_like_counts to anon, authenticated;
create policy "Anyone can read like counts" on public.character_like_counts
  for select to anon, authenticated using (true);

create or replace function public.sync_character_like_count()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    insert into public.character_like_counts (character_owner_id, character_id, like_count)
    values (new.character_owner_id, new.character_id, 1)
    on conflict (character_owner_id, character_id)
    do update set like_count = public.character_like_counts.like_count + 1;
    return new;
  elsif tg_op = 'DELETE' then
    update public.character_like_counts
      set like_count = greatest(like_count - 1, 0)
      where character_owner_id = old.character_owner_id and character_id = old.character_id;
    delete from public.character_like_counts
      where character_owner_id = old.character_owner_id and character_id = old.character_id and like_count = 0;
    return old;
  end if;
  return null;
end;
$$;
revoke execute on function public.sync_character_like_count() from public, anon, authenticated;

create trigger character_likes_count_sync
after insert or delete on public.character_likes
for each row execute function public.sync_character_like_count();

-- 2) 내 좋아요 조회는 본인 읽기 정책으로 충분하므로 INVOKER로 전환
create or replace function public.get_my_character_likes()
returns table(character_owner_id uuid, character_id text)
language sql stable security invoker set search_path = '' as $$
  select l.character_owner_id, l.character_id
  from public.character_likes as l
  where l.user_id = (select auth.uid())
$$;

-- 3) 중복 INSERT 정책 제거
drop policy if exists "Logged in users can create own posts" on public.community_posts;

-- 4) auth.uid() 를 (select auth.uid()) 로 바꿔 행마다 재평가하지 않게
drop policy if exists "Users can insert own community posts" on public.community_posts;
create policy "Users can insert own community posts" on public.community_posts
  for insert to authenticated with check ((select auth.uid()) = user_id);

drop policy if exists "Users can read own chat history" on public.chat_histories;
drop policy if exists "Users can insert own chat history" on public.chat_histories;
drop policy if exists "Users can update own chat history" on public.chat_histories;
create policy "Users can read own chat history" on public.chat_histories
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users can insert own chat history" on public.chat_histories
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users can update own chat history" on public.chat_histories
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists "Users can read own characters" on public.user_characters;
drop policy if exists "Users can insert own characters" on public.user_characters;
drop policy if exists "Users can update own characters" on public.user_characters;
create policy "Users can read own characters" on public.user_characters
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users can insert own characters" on public.user_characters
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users can update own characters" on public.user_characters
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists "Users can insert own profile" on public.user_profiles;
drop policy if exists "Users can update own profile" on public.user_profiles;
create policy "Users can insert own profile" on public.user_profiles
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users can update own profile" on public.user_profiles
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- 5) 외래키 인덱스
create index if not exists community_posts_user_id_idx on public.community_posts (user_id);
create index if not exists credit_transactions_user_id_idx on public.credit_transactions (user_id);
create index if not exists follows_following_id_idx on public.follows (following_id);
