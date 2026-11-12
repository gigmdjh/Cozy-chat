-- 비로그인 사용자는 좋아요 원본에 접근할 필요 없음 (개수는 character_like_counts)
revoke select on public.character_likes from anon;
revoke select (character_owner_id, character_id) on public.character_likes from anon;
-- 로그인 사용자는 RLS로 본인 행만 보이므로 전체 열 읽기 허용
-- (get_my_character_likes 와 좋아요 취소의 user_id 조건에 필요)
grant select on public.character_likes to authenticated;
