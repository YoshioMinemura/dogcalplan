-- ensure_care_profile の RETURNS TABLE 出力変数 user_id と
-- ON CONFLICT の列名が曖昧になる問題を修正する。
-- 202609050001_care_features.sql 適用後に実行する。

create or replace function public.ensure_care_profile(p_display_name text default null)
returns table (user_id uuid, display_name text, household_id uuid, role text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_household_id uuid;
  v_name text;
begin
  if v_user_id is null then raise exception 'authentication required' using errcode = '42501'; end if;
  v_household_id := public.my_household_id();
  if v_household_id is null then raise exception 'household access denied' using errcode = '42501'; end if;
  v_name := nullif(trim(coalesce(p_display_name, '')), '');
  insert into public.profiles (user_id, display_name)
  values (v_user_id, coalesce(left(v_name, 60), '家族'))
  on conflict on constraint profiles_pkey do update
    set display_name = case when v_name is null then public.profiles.display_name else left(v_name, 60) end,
        updated_at = now();
  insert into public.notification_preferences (user_id) values (v_user_id) on conflict do nothing;
  insert into public.eye_drop_settings (household_id, updated_by)
  values (v_household_id, v_user_id) on conflict do nothing;
  return query
    select profile.user_id, profile.display_name, member.household_id, member.role
    from public.profiles profile
    join public.household_members member on member.user_id = profile.user_id
    where profile.user_id = v_user_id and member.household_id = v_household_id;
end;
$$;

revoke all on function public.ensure_care_profile(text) from public, anon;
grant execute on function public.ensure_care_profile(text) to authenticated;
