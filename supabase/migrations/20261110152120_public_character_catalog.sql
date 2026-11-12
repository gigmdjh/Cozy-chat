create table if not exists public.public_characters (
  user_id uuid not null references auth.users(id) on delete cascade,
  character_id text not null,
  character_data jsonb not null,
  visibility text not null check (visibility in ('public','unlisted')),
  updated_at timestamptz not null default now(),
  primary key (user_id, character_id)
);
alter table public.public_characters enable row level security;
grant usage on schema public to anon, authenticated;
grant select on public.public_characters to anon, authenticated;
grant insert, update, delete on public.public_characters to authenticated;
drop policy if exists "Public characters are viewable" on public.public_characters;
create policy "Public characters are viewable" on public.public_characters
  for select to anon, authenticated
  using (visibility in ('public','unlisted') or (select auth.uid()) = user_id);
drop policy if exists "Users can publish own characters" on public.public_characters;
create policy "Users can publish own characters" on public.public_characters
  for insert to authenticated
  with check ((select auth.uid()) = user_id);
drop policy if exists "Users can update own published characters" on public.public_characters;
create policy "Users can update own published characters" on public.public_characters
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
drop policy if exists "Users can remove own published characters" on public.public_characters;
create policy "Users can remove own published characters" on public.public_characters
  for delete to authenticated
  using ((select auth.uid()) = user_id);
