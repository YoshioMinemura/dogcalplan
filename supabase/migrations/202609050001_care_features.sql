-- べぬケアごはん: 操作者プロフィール、排泄、点眼、Web Push基盤
-- 既存の 202608290001_family_sync.sql 適用後に実行する。

alter table public.household_members
  add column if not exists role text not null default 'member'
  check (role in ('admin', 'member'));

update public.household_members member
set role = 'admin'
from public.households household
where household.id = member.household_id
  and household.created_by = member.user_id;

create or replace function public.assign_household_creator_role()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.households household
    where household.id = new.household_id and household.created_by = new.user_id
  ) then
    new.role := 'admin';
  end if;
  return new;
end;
$$;

drop trigger if exists assign_household_creator_role on public.household_members;
create trigger assign_household_creator_role
before insert on public.household_members
for each row execute function public.assign_household_creator_role();

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 60),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.health_events (
  id uuid primary key,
  household_id uuid not null references public.households(id) on delete cascade,
  event_type text not null check (event_type in ('urine', 'stool')),
  occurred_at timestamptz not null,
  recorded_by uuid not null references auth.users(id) on delete restrict,
  recorded_by_name text not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'VOIDED')),
  void_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists health_events_household_time_idx
  on public.health_events (household_id, occurred_at desc);

create table if not exists public.eye_drop_settings (
  household_id uuid primary key references public.households(id) on delete cascade,
  drop_types jsonb not null default '[{"id":"drop-1","name":"1","requiredDailyCount":0},{"id":"drop-2","name":"2","requiredDailyCount":0},{"id":"drop-2-5","name":"2.5","requiredDailyCount":0},{"id":"drop-3","name":"3","requiredDailyCount":0}]'::jsonb,
  templates jsonb not null default '[{"time":"06:00","steps":[]},{"time":"08:00","steps":[]},{"time":"10:00","steps":[]},{"time":"12:00","steps":[]},{"time":"14:00","steps":[]},{"time":"16:00","steps":[]},{"time":"18:00","steps":[]},{"time":"20:00","steps":[]},{"time":"22:00","steps":[]}]'::jsonb,
  interval_seconds integer not null default 300 check (interval_seconds between 60 and 3600),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  check (jsonb_typeof(drop_types) = 'array'),
  check (jsonb_typeof(templates) = 'array')
);

create table if not exists public.eye_drop_sessions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  local_date date not null,
  scheduled_time time not null,
  scheduled_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'in_progress', 'completed', 'cancelled')),
  operator_user_id uuid references auth.users(id) on delete set null,
  operator_display_name text,
  started_at timestamptz,
  completed_at timestamptz,
  next_due_at timestamptz,
  interval_seconds integer not null check (interval_seconds between 60 and 3600),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, local_date, scheduled_time)
);

create index if not exists eye_drop_sessions_household_date_idx
  on public.eye_drop_sessions (household_id, local_date, scheduled_time);

create table if not exists public.eye_drop_steps (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.eye_drop_sessions(id) on delete cascade,
  drop_type_id text not null,
  drop_name text not null,
  step_order integer not null check (step_order > 0),
  status text not null default 'pending' check (status in ('pending', 'waiting', 'completed', 'cancelled')),
  available_at timestamptz,
  completed_at timestamptz,
  completed_by uuid references auth.users(id) on delete set null,
  completed_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, step_order)
);

create table if not exists public.notification_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  master_enabled boolean not null default false,
  scheduled_eye_drop_enabled boolean not null default true,
  active_eye_drop_timer_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists public.notification_jobs (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  target_user_id uuid references auth.users(id) on delete cascade,
  job_type text not null check (job_type in ('eye_drop_session_start', 'eye_drop_next_step')),
  related_session_id uuid references public.eye_drop_sessions(id) on delete cascade,
  due_at timestamptz not null,
  sent_at timestamptz,
  cancelled_at timestamptz,
  dedupe_key text not null unique,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists notification_jobs_due_idx
  on public.notification_jobs (due_at) where sent_at is null and cancelled_at is null;

alter table public.profiles enable row level security;
alter table public.health_events enable row level security;
alter table public.eye_drop_settings enable row level security;
alter table public.eye_drop_sessions enable row level security;
alter table public.eye_drop_steps enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.notification_jobs enable row level security;

create or replace function public.my_household_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select member.household_id
  from public.household_members member
  where member.user_id = (select auth.uid())
  order by member.joined_at
  limit 1;
$$;

create or replace function public.is_household_admin(p_household_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.household_members member
    where member.household_id = p_household_id
      and member.user_id = (select auth.uid())
      and member.role = 'admin'
  );
$$;

drop policy if exists "users can read own profile" on public.profiles;
create policy "users can read own profile" on public.profiles for select to authenticated
using (user_id = (select auth.uid()));
drop policy if exists "users can update own profile" on public.profiles;
create policy "users can update own profile" on public.profiles for update to authenticated
using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists "members can read health events" on public.health_events;
create policy "members can read health events" on public.health_events for select to authenticated
using ((select public.is_household_member(household_id)));
drop policy if exists "members can read eye settings" on public.eye_drop_settings;
create policy "members can read eye settings" on public.eye_drop_settings for select to authenticated
using ((select public.is_household_member(household_id)));
drop policy if exists "members can read eye sessions" on public.eye_drop_sessions;
create policy "members can read eye sessions" on public.eye_drop_sessions for select to authenticated
using ((select public.is_household_member(household_id)));
drop policy if exists "members can read eye steps" on public.eye_drop_steps;
create policy "members can read eye steps" on public.eye_drop_steps for select to authenticated
using (exists (
  select 1 from public.eye_drop_sessions session
  where session.id = eye_drop_steps.session_id
    and public.is_household_member(session.household_id)
));
drop policy if exists "users can read own notification preferences" on public.notification_preferences;
create policy "users can read own notification preferences" on public.notification_preferences for select to authenticated
using (user_id = (select auth.uid()));
drop policy if exists "users can read own subscriptions" on public.push_subscriptions;
create policy "users can read own subscriptions" on public.push_subscriptions for select to authenticated
using (user_id = (select auth.uid()));

grant select on public.profiles, public.health_events, public.eye_drop_settings,
  public.eye_drop_sessions, public.eye_drop_steps, public.notification_preferences,
  public.push_subscriptions to authenticated;

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
  on conflict (user_id) do update
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

create or replace function public.save_eye_drop_settings(
  p_drop_types jsonb,
  p_templates jsonb,
  p_interval_seconds integer
)
returns public.eye_drop_settings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household_id uuid := public.my_household_id();
  v_result public.eye_drop_settings;
begin
  if not public.is_household_admin(v_household_id) then raise exception 'admin required' using errcode = '42501'; end if;
  if jsonb_typeof(p_drop_types) <> 'array' or jsonb_typeof(p_templates) <> 'array' then
    raise exception 'invalid eye drop settings' using errcode = '22023';
  end if;
  if p_interval_seconds < 60 or p_interval_seconds > 3600 then
    raise exception 'invalid interval' using errcode = '22023';
  end if;
  insert into public.eye_drop_settings (household_id, drop_types, templates, interval_seconds, updated_at, updated_by)
  values (v_household_id, p_drop_types, p_templates, p_interval_seconds, now(), auth.uid())
  on conflict (household_id) do update set
    drop_types = excluded.drop_types,
    templates = excluded.templates,
    interval_seconds = excluded.interval_seconds,
    updated_at = now(),
    updated_by = auth.uid()
  returning * into v_result;
  return v_result;
end;
$$;

create or replace function public.ensure_eye_drop_sessions(p_local_date date, p_timezone text default 'Asia/Tokyo')
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_household_id uuid := public.my_household_id();
  v_settings public.eye_drop_settings;
  v_template jsonb;
  v_step_id text;
  v_session_id uuid;
  v_session_created boolean;
  v_order integer;
  v_name text;
begin
  if v_household_id is null then raise exception 'household access denied' using errcode = '42501'; end if;
  insert into public.eye_drop_settings (household_id, updated_by)
  values (v_household_id, auth.uid()) on conflict do nothing;
  select * into v_settings from public.eye_drop_settings where household_id = v_household_id;
  for v_template in select value from jsonb_array_elements(v_settings.templates)
  loop
    if coalesce(v_template->>'time', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then continue; end if;
    v_session_id := null;
    insert into public.eye_drop_sessions (
      household_id, local_date, scheduled_time, scheduled_at, interval_seconds
    ) values (
      v_household_id,
      p_local_date,
      (v_template->>'time')::time,
      ((p_local_date::text || ' ' || (v_template->>'time'))::timestamp at time zone p_timezone),
      v_settings.interval_seconds
    ) on conflict (household_id, local_date, scheduled_time) do nothing
    returning id into v_session_id;
    v_session_created := v_session_id is not null;
    if v_session_id is null then
      select id into v_session_id from public.eye_drop_sessions
      where household_id = v_household_id and local_date = p_local_date
        and scheduled_time = (v_template->>'time')::time;
    end if;
    if v_session_created then
      v_order := 0;
      for v_step_id in select jsonb_array_elements_text(coalesce(v_template->'steps', '[]'::jsonb))
      loop
        v_order := v_order + 1;
        select item->>'name' into v_name
        from jsonb_array_elements(v_settings.drop_types) item
        where item->>'id' = v_step_id limit 1;
        if v_name is not null then
          insert into public.eye_drop_steps (session_id, drop_type_id, drop_name, step_order)
          values (v_session_id, v_step_id, v_name, v_order);
        end if;
      end loop;
    end if;
    if exists (select 1 from public.eye_drop_steps where session_id = v_session_id) then
      insert into public.notification_jobs (
        household_id, job_type, related_session_id, due_at, dedupe_key, payload
      ) values (
        v_household_id, 'eye_drop_session_start', v_session_id,
        ((p_local_date::text || ' ' || (v_template->>'time'))::timestamp at time zone p_timezone),
        'eye-session:' || v_session_id::text || ':start',
        jsonb_build_object('title', (v_template->>'time') || 'の点眼時間です', 'sessionId', v_session_id)
      ) on conflict (dedupe_key) do nothing;
    end if;
  end loop;
end;
$$;

create or replace function public.claim_eye_drop_session(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_name text;
  v_session public.eye_drop_sessions;
begin
  select display_name into v_name from public.profiles where user_id = v_user_id;
  update public.eye_drop_sessions session set
    operator_user_id = v_user_id,
    operator_display_name = coalesce(v_name, '家族'),
    status = 'in_progress',
    started_at = coalesce(session.started_at, now()),
    updated_at = now()
  where session.id = p_session_id
    and public.is_household_member(session.household_id)
    and session.operator_user_id is null
    and session.status = 'pending'
  returning * into v_session;
  if v_session.id is null then
    select * into v_session from public.eye_drop_sessions where id = p_session_id;
    if v_session.id is null or not public.is_household_member(v_session.household_id) then
      raise exception 'session not found' using errcode = 'P0002';
    end if;
    raise exception 'session already claimed by %', coalesce(v_session.operator_display_name, '別の家族') using errcode = 'P0001';
  end if;
  return to_jsonb(v_session);
end;
$$;

create or replace function public.complete_eye_drop_step(p_step_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_name text;
  v_step public.eye_drop_steps;
  v_session public.eye_drop_sessions;
  v_next public.eye_drop_steps;
  v_completed_at timestamptz := clock_timestamp();
begin
  select session.* into v_session
  from public.eye_drop_sessions session
  join public.eye_drop_steps step on step.session_id = session.id
  where step.id = p_step_id
  for update of session;
  if v_session.id is null then raise exception 'step not found' using errcode = 'P0002'; end if;
  select step.* into v_step
  from public.eye_drop_steps step
  where step.id = p_step_id
  for update;
  if not public.is_household_member(v_session.household_id) then raise exception 'household access denied' using errcode = '42501'; end if;
  if v_session.operator_user_id is distinct from v_user_id then raise exception 'operator only' using errcode = '42501'; end if;
  if v_step.status = 'completed' then return jsonb_build_object('session', to_jsonb(v_session), 'step', to_jsonb(v_step)); end if;
  if exists (select 1 from public.eye_drop_steps prior where prior.session_id = v_step.session_id and prior.step_order < v_step.step_order and prior.status <> 'completed') then
    raise exception 'previous step is incomplete' using errcode = 'P0001';
  end if;
  if v_step.available_at is not null and v_completed_at < v_step.available_at then
    raise exception 'too early; available at %', v_step.available_at using errcode = 'P0001';
  end if;
  select display_name into v_name from public.profiles where user_id = v_user_id;
  update public.eye_drop_steps set status = 'completed', completed_at = v_completed_at,
    completed_by = v_user_id, completed_by_name = coalesce(v_name, '家族'), updated_at = v_completed_at
  where id = p_step_id returning * into v_step;
  select * into v_next from public.eye_drop_steps
  where session_id = v_step.session_id and step_order > v_step.step_order and status <> 'completed'
  order by step_order limit 1;
  if v_next.id is null then
    update public.eye_drop_sessions set status = 'completed', completed_at = v_completed_at,
      next_due_at = null, updated_at = v_completed_at where id = v_step.session_id returning * into v_session;
  else
    update public.eye_drop_steps set status = 'waiting',
      available_at = v_completed_at + make_interval(secs => v_session.interval_seconds), updated_at = v_completed_at
    where id = v_next.id returning * into v_next;
    update public.eye_drop_sessions set next_due_at = v_next.available_at, updated_at = v_completed_at
    where id = v_step.session_id returning * into v_session;
    insert into public.notification_jobs (
      household_id, target_user_id, job_type, related_session_id, due_at, dedupe_key, payload
    ) values (
      v_session.household_id, v_user_id, 'eye_drop_next_step', v_session.id,
      v_next.available_at, 'eye-step:' || v_next.id::text || ':ready',
      jsonb_build_object('title', '点眼' || v_next.drop_name || 'の時間です', 'sessionId', v_session.id, 'stepId', v_next.id)
    ) on conflict (dedupe_key) do nothing;
  end if;
  return jsonb_build_object('session', to_jsonb(v_session), 'step', to_jsonb(v_step), 'nextStep', to_jsonb(v_next));
end;
$$;

create or replace function public.takeover_eye_drop_session(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_name text;
  v_session public.eye_drop_sessions;
begin
  select display_name into v_name from public.profiles where user_id = v_user_id;
  update public.eye_drop_sessions session set operator_user_id = v_user_id,
    operator_display_name = coalesce(v_name, '家族'), updated_at = now()
  where session.id = p_session_id and public.is_household_member(session.household_id)
    and session.status = 'in_progress'
  returning * into v_session;
  if v_session.id is null then raise exception 'active session not found' using errcode = 'P0002'; end if;
  update public.notification_jobs set target_user_id = v_user_id
  where related_session_id = p_session_id and job_type = 'eye_drop_next_step'
    and sent_at is null and cancelled_at is null;
  return to_jsonb(v_session);
end;
$$;

create or replace function public.record_health_event(
  p_id uuid,
  p_event_type text,
  p_occurred_at timestamptz default now()
)
returns public.health_events
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_household_id uuid := public.my_household_id();
  v_name text;
  v_result public.health_events;
begin
  if p_event_type not in ('urine', 'stool') then raise exception 'invalid event type' using errcode = '22023'; end if;
  select display_name into v_name from public.profiles where user_id = v_user_id;
  insert into public.health_events (id, household_id, event_type, occurred_at, recorded_by, recorded_by_name)
  values (p_id, v_household_id, p_event_type, p_occurred_at, v_user_id, coalesce(v_name, '家族'))
  on conflict (id) do update set updated_at = public.health_events.updated_at
  returning * into v_result;
  return v_result;
end;
$$;

create or replace function public.void_health_event(p_event_id uuid)
returns public.health_events
language plpgsql
security definer
set search_path = ''
as $$
declare v_result public.health_events;
begin
  update public.health_events event set status = 'VOIDED', void_reason = '利用者による取消し', updated_at = now()
  where event.id = p_event_id and public.is_household_member(event.household_id)
  returning * into v_result;
  if v_result.id is null then raise exception 'event not found' using errcode = 'P0002'; end if;
  return v_result;
end;
$$;

create or replace function public.save_notification_preferences(
  p_master_enabled boolean,
  p_scheduled_enabled boolean,
  p_timer_enabled boolean
)
returns public.notification_preferences
language plpgsql
security definer
set search_path = ''
as $$
declare v_result public.notification_preferences;
begin
  insert into public.notification_preferences (user_id, master_enabled, scheduled_eye_drop_enabled, active_eye_drop_timer_enabled, updated_at)
  values (auth.uid(), p_master_enabled, p_scheduled_enabled, p_timer_enabled, now())
  on conflict (user_id) do update set master_enabled = excluded.master_enabled,
    scheduled_eye_drop_enabled = excluded.scheduled_eye_drop_enabled,
    active_eye_drop_timer_enabled = excluded.active_eye_drop_timer_enabled, updated_at = now()
  returning * into v_result;
  return v_result;
end;
$$;

create or replace function public.register_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update set user_id = auth.uid(), p256dh = excluded.p256dh,
    auth = excluded.auth, enabled = true, last_seen_at = now();
end;
$$;

revoke all on function public.assign_household_creator_role() from public, anon, authenticated;
revoke all on function public.my_household_id() from public, anon;
revoke all on function public.is_household_admin(uuid) from public, anon;
revoke all on function public.ensure_care_profile(text) from public, anon;
revoke all on function public.save_eye_drop_settings(jsonb, jsonb, integer) from public, anon;
revoke all on function public.ensure_eye_drop_sessions(date, text) from public, anon;
revoke all on function public.claim_eye_drop_session(uuid) from public, anon;
revoke all on function public.complete_eye_drop_step(uuid) from public, anon;
revoke all on function public.takeover_eye_drop_session(uuid) from public, anon;
revoke all on function public.record_health_event(uuid, text, timestamptz) from public, anon;
revoke all on function public.void_health_event(uuid) from public, anon;
revoke all on function public.save_notification_preferences(boolean, boolean, boolean) from public, anon;
revoke all on function public.register_push_subscription(text, text, text) from public, anon;

grant execute on function public.my_household_id() to authenticated;
grant execute on function public.is_household_admin(uuid) to authenticated;
grant execute on function public.ensure_care_profile(text) to authenticated;
grant execute on function public.save_eye_drop_settings(jsonb, jsonb, integer) to authenticated;
grant execute on function public.ensure_eye_drop_sessions(date, text) to authenticated;
grant execute on function public.claim_eye_drop_session(uuid) to authenticated;
grant execute on function public.complete_eye_drop_step(uuid) to authenticated;
grant execute on function public.takeover_eye_drop_session(uuid) to authenticated;
grant execute on function public.record_health_event(uuid, text, timestamptz) to authenticated;
grant execute on function public.void_health_event(uuid) to authenticated;
grant execute on function public.save_notification_preferences(boolean, boolean, boolean) to authenticated;
grant execute on function public.register_push_subscription(text, text, text) to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.health_events;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.eye_drop_sessions;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.eye_drop_steps;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.eye_drop_settings;
exception when duplicate_object then null;
end $$;

alter table public.health_events replica identity full;
alter table public.eye_drop_sessions replica identity full;
alter table public.eye_drop_steps replica identity full;
alter table public.eye_drop_settings replica identity full;
