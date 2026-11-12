-- 공개 캐릭터 정책이 user_preferences 를 확인할 수 있게 anon 에도 읽기 권한을 준다.
-- anon 용 RLS 정책은 없으므로 실제로 보이는 행은 0개다.
grant select on public.user_preferences to anon;
