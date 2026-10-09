-- Additive migration: early completion, complete-all and rewind for eye-drop sessions,
-- plus daily health counts for the meal history list. Apply after 202609100001.
alter table public.eye_drop_sessions
  add column if not exists action_history jsonb not null default '[]'::jsonb;

-- Complete the next step without waiting for available_at. The ready notification for
-- this step is cancelled; the following step keeps the normal interval and notification.
create or replace function public.complete_eye_drop_step_now(p_step_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
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
  select step.* into v_step from public.eye_drop_steps step where step.id = p_step_id for update;
  if not public.is_household_member(v_session.household_id) then raise exception 'household access denied' using errcode = '42501'; end if;
  if v_session.operator_user_id is distinct from v_user_id then raise exception 'operator only' using errcode = '42501'; end if;
  if v_step.status = 'completed' then return jsonb_build_object('session', to_jsonb(v_session), 'step', to_jsonb(v_step)); end if;
  if v_step.status = 'cancelled' then raise exception 'step cancelled' using errcode = 'P0001'; end if;
  if exists (select 1 from public.eye_drop_steps prior where prior.session_id = v_step.session_id and prior.step_order < v_step.step_order and prior.status not in ('completed', 'cancelled')) then
    raise exception 'previous step is incomplete' using errcode = 'P0001';
  end if;
  select display_name into v_name from public.profiles where user_id = v_user_id;
  update public.eye_drop_steps set status = 'completed', completed_at = v_completed_at,
    completed_by = v_user_id, completed_by_name = coalesce(v_name, '家族'), updated_at = v_completed_at
  where id = p_step_id returning * into v_step;
  update public.notification_jobs set cancelled_at = v_completed_at
  where dedupe_key = 'eye-step:' || p_step_id::text || ':ready' and sent_at is null and cancelled_at is null;
  select * into v_next from public.eye_drop_steps
  where session_id = v_step.session_id and step_order > v_step.step_order and status not in ('completed', 'cancelled')
  order by step_order limit 1;
  if v_next.id is null then
    update public.eye_drop_sessions set status = 'completed', completed_at = v_completed_at,
      next_due_at = null, updated_at = v_completed_at,
      action_history = action_history || jsonb_build_array(jsonb_build_object('action', 'complete_now',
        'step_id', v_step.id, 'drop_name', v_step.drop_name, 'available_at', v_step.available_at,
        'by', v_user_id, 'by_name', coalesce(v_name, '家族'), 'at', v_completed_at))
    where id = v_step.session_id returning * into v_session;
  else
    update public.eye_drop_steps set status = 'waiting',
      available_at = v_completed_at + make_interval(secs => v_session.interval_seconds), updated_at = v_completed_at
    where id = v_next.id returning * into v_next;
    update public.eye_drop_sessions set next_due_at = v_next.available_at, updated_at = v_completed_at,
      action_history = action_history || jsonb_build_array(jsonb_build_object('action', 'complete_now',
        'step_id', v_step.id, 'drop_name', v_step.drop_name, 'available_at', v_step.available_at,
        'by', v_user_id, 'by_name', coalesce(v_name, '家族'), 'at', v_completed_at))
    where id = v_step.session_id returning * into v_session;
    insert into public.notification_jobs (
      household_id, target_user_id, job_type, related_session_id, due_at, dedupe_key, payload
    ) values (
      v_session.household_id, v_user_id, 'eye_drop_next_step', v_session.id,
      v_next.available_at, 'eye-step:' || v_next.id::text || ':ready',
      jsonb_build_object('title', '点眼' || v_next.drop_name || 'の時間です', 'sessionId', v_session.id, 'stepId', v_next.id)
    ) on conflict (dedupe_key) do update set due_at = excluded.due_at, target_user_id = excluded.target_user_id,
      cancelled_at = null
    where public.notification_jobs.sent_at is null;
  end if;
  return jsonb_build_object('session', to_jsonb(v_session), 'step', to_jsonb(v_step), 'nextStep', to_jsonb(v_next));
end;
$$;

-- Complete every remaining step at the current server time. An unclaimed session is
-- claimed by the caller first so a forgotten session can be recorded in one action.
create or replace function public.complete_eye_drop_session(p_session_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_name text;
  v_session public.eye_drop_sessions;
  v_completed_at timestamptz := clock_timestamp();
  v_count integer;
begin
  select * into v_session from public.eye_drop_sessions where id = p_session_id for update;
  if v_session.id is null or not public.is_household_member(v_session.household_id) then
    raise exception 'session not found' using errcode = 'P0002';
  end if;
  if v_session.status = 'completed' then return to_jsonb(v_session); end if;
  if v_session.status = 'cancelled' then raise exception 'session cancelled' using errcode = 'P0001'; end if;
  if v_session.status = 'in_progress' and v_session.operator_user_id is distinct from v_user_id then
    raise exception 'operator only' using errcode = '42501';
  end if;
  select display_name into v_name from public.profiles where user_id = v_user_id;
  update public.eye_drop_steps set status = 'completed', completed_at = v_completed_at,
    completed_by = v_user_id, completed_by_name = coalesce(v_name, '家族'), updated_at = v_completed_at
  where session_id = p_session_id and status not in ('completed', 'cancelled');
  get diagnostics v_count = row_count;
  update public.notification_jobs set cancelled_at = v_completed_at
  where related_session_id = p_session_id and sent_at is null and cancelled_at is null;
  update public.eye_drop_sessions set status = 'completed', completed_at = v_completed_at,
    operator_user_id = v_user_id, operator_display_name = coalesce(v_name, '家族'),
    started_at = coalesce(started_at, v_completed_at), next_due_at = null, updated_at = v_completed_at,
    action_history = action_history || jsonb_build_array(jsonb_build_object('action', 'complete_all',
      'completed_steps', v_count, 'previous_status', v_session.status,
      'by', v_user_id, 'by_name', coalesce(v_name, '家族'), 'at', v_completed_at))
  where id = p_session_id returning * into v_session;
  return to_jsonb(v_session);
end;
$$;

-- Undo the latest completed step. With no completed step, release the session back to
-- the unclaimed state. Each rewind keeps the previous completion in action_history.
create or replace function public.rewind_eye_drop_step(p_session_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_name text;
  v_session public.eye_drop_sessions;
  v_step public.eye_drop_steps;
  v_stamp timestamptz := clock_timestamp();
begin
  select * into v_session from public.eye_drop_sessions where id = p_session_id for update;
  if v_session.id is null or not public.is_household_member(v_session.household_id) then
    raise exception 'session not found' using errcode = 'P0002';
  end if;
  if v_session.status = 'in_progress' and v_session.operator_user_id is distinct from v_user_id then
    raise exception 'operator only' using errcode = '42501';
  end if;
  if v_session.status not in ('in_progress', 'completed') then
    raise exception 'nothing to rewind' using errcode = 'P0001';
  end if;
  select display_name into v_name from public.profiles where user_id = v_user_id;
  select * into v_step from public.eye_drop_steps
  where session_id = p_session_id and status = 'completed'
  order by step_order desc limit 1 for update;

  update public.notification_jobs set cancelled_at = v_stamp
  where related_session_id = p_session_id and job_type = 'eye_drop_next_step'
    and sent_at is null and cancelled_at is null;

  if v_step.id is null then
    update public.eye_drop_steps set status = 'pending', available_at = null, updated_at = v_stamp
    where session_id = p_session_id and status <> 'cancelled';
    update public.eye_drop_sessions set status = 'pending', operator_user_id = null,
      operator_display_name = null, started_at = null, completed_at = null, next_due_at = null, updated_at = v_stamp,
      action_history = action_history || jsonb_build_array(jsonb_build_object('action', 'release',
        'previous_operator_name', v_session.operator_display_name,
        'by', v_user_id, 'by_name', coalesce(v_name, '家族'), 'at', v_stamp))
    where id = p_session_id returning * into v_session;
    return to_jsonb(v_session);
  end if;

  update public.eye_drop_steps set status = 'pending', available_at = null, updated_at = v_stamp
  where session_id = p_session_id and step_order > v_step.step_order and status <> 'cancelled';
  update public.eye_drop_steps set status = case when available_at is null then 'pending' else 'waiting' end,
    completed_at = null, completed_by = null, completed_by_name = null, updated_at = v_stamp
  where id = v_step.id;
  update public.eye_drop_sessions set status = 'in_progress', completed_at = null,
    operator_user_id = v_user_id, operator_display_name = coalesce(v_name, '家族'),
    next_due_at = case when v_step.available_at > v_stamp then v_step.available_at else null end,
    updated_at = v_stamp,
    action_history = action_history || jsonb_build_array(jsonb_build_object('action', 'rewind',
      'step_id', v_step.id, 'drop_name', v_step.drop_name,
      'previous_completed_at', v_step.completed_at, 'previous_completed_by_name', v_step.completed_by_name,
      'by', v_user_id, 'by_name', coalesce(v_name, '家族'), 'at', v_stamp))
  where id = p_session_id returning * into v_session;
  if v_step.available_at > v_stamp then
    insert into public.notification_jobs (
      household_id, target_user_id, job_type, related_session_id, due_at, dedupe_key, payload
    ) values (
      v_session.household_id, v_user_id, 'eye_drop_next_step', v_session.id,
      v_step.available_at, 'eye-step:' || v_step.id::text || ':ready',
      jsonb_build_object('title', '点眼' || v_step.drop_name || 'の時間です', 'sessionId', v_session.id, 'stepId', v_step.id)
    ) on conflict (dedupe_key) do update set due_at = excluded.due_at, target_user_id = excluded.target_user_id,
      cancelled_at = null
    where public.notification_jobs.sent_at is null;
  end if;
  return to_jsonb(v_session);
end;
$$;

-- Active urine/stool counts per local date for the caller's household.
create or replace function public.health_event_daily_counts(p_timezone text default 'Asia/Tokyo')
returns table (local_date date, urine_count integer, stool_count integer)
language sql stable security definer set search_path = ''
as $$
  select (event.occurred_at at time zone p_timezone)::date,
    count(*) filter (where event.event_type = 'urine')::integer,
    count(*) filter (where event.event_type = 'stool')::integer
  from public.health_events event
  where event.household_id = public.my_household_id() and event.status = 'ACTIVE'
  group by 1;
$$;

revoke all on function public.complete_eye_drop_step_now(uuid) from public, anon;
revoke all on function public.complete_eye_drop_session(uuid) from public, anon;
revoke all on function public.rewind_eye_drop_step(uuid) from public, anon;
revoke all on function public.health_event_daily_counts(text) from public, anon;
grant execute on function public.complete_eye_drop_step_now(uuid) to authenticated;
grant execute on function public.complete_eye_drop_session(uuid) to authenticated;
grant execute on function public.rewind_eye_drop_step(uuid) to authenticated;
grant execute on function public.health_event_daily_counts(text) to authenticated;
