create table if not exists public.character_likes (
  user_id uuid not null references auth.users(id) on delete cascade,
  character_owner_id uuid not null references auth.users(id) on delete cascade,
  character_id text not null,
  created_at timestamptz not null default now(),
  constraint character_likes_pkey primary key (user_id, character_owner_id, character_id),
  constraint character_likes_character_id_nonempty check (length(trim(character_id)) > 0)
);
create index if not exists character_likes_target_idx
  on public.character_likes (character_owner_id, character_id);
alter table public.character_likes enable row level security;
drop policy if exists "Users can read their own character likes" on public.character_likes;
create policy "Users can read their own character likes"
  on public.character_likes for select to authenticated
  using ((select auth.uid()) = user_id);
drop policy if exists "Users can add their own character likes" on public.character_likes;
create policy "Users can add their own character likes"
  on public.character_likes for insert to authenticated
  with check ((select auth.uid()) = user_id);
drop policy if exists "Users can remove their own character likes" on public.character_likes;
create policy "Users can remove their own character likes"
  on public.character_likes for delete to authenticated
  using ((select auth.uid()) = user_id);
grant select, insert, delete on public.character_likes to authenticated;
create or replace view public.character_like_counts as
  select character_owner_id, character_id, count(*)::bigint as like_count
  from public.character_likes
  group by character_owner_id, character_id;
grant select on public.character_like_counts to anon, authenticated;
