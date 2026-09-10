-- Additive migration: old clients can continue to record and edit times.
alter table public.health_events
  add column if not exists note text not null default '' check (char_length(note) <= 2000),
  add column if not exists note_edit_history jsonb not null default '[]'::jsonb;

create or replace function public.record_health_event_with_note(
  p_id uuid, p_event_type text, p_occurred_at timestamptz, p_note text
)
returns public.health_events
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_household uuid := public.my_household_id();
  v_name text;
  v_event public.health_events;
  v_note text := btrim(coalesce(p_note, ''));
begin
  if v_user is null or v_household is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if p_event_type is null or p_event_type not in ('urine', 'stool')
    or p_occurred_at is null or not isfinite(p_occurred_at) or char_length(v_note) > 2000 then
    raise exception 'invalid health record' using errcode = '22023';
  end if;
  select display_name into v_name from public.profiles where user_id = v_user;
  insert into public.health_events (id, household_id, event_type, occurred_at, recorded_by, recorded_by_name, note)
    values (p_id, v_household, p_event_type, p_occurred_at, v_user, coalesce(v_name, '家族'), v_note)
    on conflict (id) do nothing returning * into v_event;
  if v_event.id is null then
    select * into v_event from public.health_events event
      where event.id = p_id and event.household_id = v_household and event.recorded_by = v_user;
    if v_event.id is null then raise exception 'event not found' using errcode = 'P0002'; end if;
  end if;
  return v_event;
end;
$$;

create or replace function public.edit_health_event(
  p_event_id uuid, p_occurred_at timestamptz, p_note text, p_expected_updated_at timestamptz
)
returns public.health_events
language plpgsql security definer set search_path = ''
as $$
declare
  v_event public.health_events;
  v_note text := btrim(coalesce(p_note, ''));
  v_stamp timestamptz;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if p_occurred_at is null or not isfinite(p_occurred_at) or char_length(v_note) > 2000 then
    raise exception 'invalid health record' using errcode = '22023';
  end if;
  select * into v_event from public.health_events event
    where event.id = p_event_id and public.is_household_member(event.household_id) for update;
  if v_event.id is null then raise exception 'event not found' using errcode = 'P0002'; end if;
  if v_event.status <> 'ACTIVE' then raise exception '取消し済みの排泄記録は編集できません'; end if;
  if v_event.updated_at is distinct from p_expected_updated_at then
    raise exception '別の端末で変更されています。履歴を再読込みしてから編集してください' using errcode = '40001';
  end if;
  v_stamp := clock_timestamp();
  update public.health_events event set
    occurred_at = p_occurred_at, note = v_note, updated_at = v_stamp,
    time_edit_history = event.time_edit_history || case when event.occurred_at is distinct from p_occurred_at
      then jsonb_build_array(jsonb_build_object('previous_occurred_at', event.occurred_at,
        'occurred_at', p_occurred_at, 'edited_by', auth.uid(), 'edited_at', v_stamp)) else '[]'::jsonb end,
    note_edit_history = event.note_edit_history || case when event.note is distinct from v_note
      then jsonb_build_array(jsonb_build_object('previous_note', event.note, 'note', v_note,
        'edited_by', auth.uid(), 'edited_at', v_stamp)) else '[]'::jsonb end
    where event.id = p_event_id returning * into v_event;
  return v_event;
end;
$$;

revoke all on function public.record_health_event_with_note(uuid, text, timestamptz, text) from public, anon;
revoke all on function public.edit_health_event(uuid, timestamptz, text, timestamptz) from public, anon;
grant execute on function public.record_health_event_with_note(uuid, text, timestamptz, text) to authenticated;
grant execute on function public.edit_health_event(uuid, timestamptz, text, timestamptz) to authenticated;
