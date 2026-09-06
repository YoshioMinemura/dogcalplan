-- Keep the original time and actor when correcting a health record.
alter table public.health_events
  add column if not exists time_edit_history jsonb not null default '[]'::jsonb;

create or replace function public.edit_health_event_time(
  p_event_id uuid,
  p_occurred_at timestamptz,
  p_expected_updated_at timestamptz
)
returns public.health_events
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event public.health_events;
begin
  if auth.uid() is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if p_occurred_at is null or not isfinite(p_occurred_at) then
    raise exception 'invalid record time' using errcode = '22023';
  end if;
  select * into v_event from public.health_events event
  where event.id = p_event_id and public.is_household_member(event.household_id)
  for update;
  if v_event.id is null then raise exception 'event not found' using errcode = 'P0002'; end if;
  if v_event.status <> 'ACTIVE' then raise exception '取消し済みの排泄記録は編集できません'; end if;
  if v_event.updated_at is distinct from p_expected_updated_at then
    raise exception '別の端末で変更されています。履歴を再読込みしてから編集してください' using errcode = '40001';
  end if;
  update public.health_events event set
    occurred_at = p_occurred_at,
    updated_at = clock_timestamp(),
    time_edit_history = event.time_edit_history || jsonb_build_array(jsonb_build_object(
      'previous_occurred_at', event.occurred_at,
      'occurred_at', p_occurred_at,
      'edited_by', auth.uid(),
      'edited_at', clock_timestamp()
    ))
  where event.id = p_event_id
  returning * into v_event;
  return v_event;
end;
$$;

revoke all on function public.edit_health_event_time(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.edit_health_event_time(uuid, timestamptz, timestamptz) to authenticated;
