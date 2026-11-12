drop view if exists public.character_like_counts;
create view public.character_like_counts with (security_invoker = true) as
  select character_owner_id, character_id, count(*)::bigint as like_count
  from public.character_likes
  group by character_owner_id, character_id;
drop policy if exists "Anyone can read character like targets" on public.character_likes;
create policy "Anyone can read character like targets"
  on public.character_likes for select to anon, authenticated
  using (true);
revoke select on public.character_likes from anon, authenticated;
grant select (character_owner_id, character_id) on public.character_likes to anon, authenticated;
grant select on public.character_like_counts to anon, authenticated;
create or replace function public.get_my_character_likes()
returns table(character_owner_id uuid, character_id text)
language sql
stable
security definer
set search_path = ''
as $$
  select l.character_owner_id, l.character_id
  from public.character_likes as l
  where l.user_id = (select auth.uid())
    and (select auth.uid()) is not null
$$;
revoke all on function public.get_my_character_likes() from public;
grant execute on function public.get_my_character_likes() to authenticated;
