-- べぬケアごはん: 匿名ユーザーによる家族同期
-- Supabase Dashboard の SQL Editor で、このファイル全体を1回実行してください。

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 100),
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id) on delete restrict
);

create table if not exists public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (household_id, user_id)
);

create table if not exists public.household_invites (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  check (char_length(token_hash) = 64)
);

create table if not exists public.household_states (
  household_id uuid primary key references public.households(id) on delete cascade,
  state jsonb not null,
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now(),
  updated_by uuid not null references auth.users(id) on delete restrict,
  check (jsonb_typeof(state) = 'object'),
  check (pg_column_size(state) <= 5242880)
);

alter table public.households enable row level security;
alter table public.household_members enable row level security;
alter table public.household_invites enable row level security;
alter table public.household_states enable row level security;

revoke all on table public.households from anon, authenticated;
revoke all on table public.household_members from anon, authenticated;
revoke all on table public.household_invites from anon, authenticated;
revoke all on table public.household_states from anon, authenticated;
grant select on table public.household_states to authenticated;

create or replace function public.is_household_member(p_household_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.household_members member
    where member.household_id = p_household_id
      and member.user_id = (select auth.uid())
  );
$$;

revoke all on function public.is_household_member(uuid) from public, anon, authenticated;
grant execute on function public.is_household_member(uuid) to authenticated;

drop policy if exists "members can read household state" on public.household_states;
create policy "members can read household state"
on public.household_states
for select
to authenticated
using ((select public.is_household_member(household_id)));

create or replace function public.create_household(
  p_name text,
  p_invite_token text,
  p_initial_state jsonb
)
returns table (household_id uuid, revision bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_household_id uuid;
begin
  if v_user_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if coalesce(char_length(p_invite_token), 0) < 43 then
    raise exception 'invite token is too short' using errcode = '22023';
  end if;
  if jsonb_typeof(p_initial_state) is distinct from 'object' then
    raise exception 'initial state must be a JSON object' using errcode = '22023';
  end if;
  if pg_column_size(p_initial_state) > 5242880 then
    raise exception 'state is too large' using errcode = '22001';
  end if;

  insert into public.households (name, created_by)
  values (left(coalesce(nullif(trim(p_name), ''), 'べぬ家族'), 100), v_user_id)
  returning id into v_household_id;

  insert into public.household_members (household_id, user_id)
  values (v_household_id, v_user_id);

  insert into public.household_invites (household_id, token_hash)
  values (
    v_household_id,
    encode(extensions.digest(convert_to(p_invite_token, 'UTF8'), 'sha256'), 'hex')
  );

  insert into public.household_states (household_id, state, revision, updated_by)
  values (v_household_id, p_initial_state, 1, v_user_id);

  return query select v_household_id, 1::bigint;
end;
$$;

create or replace function public.join_household(p_invite_token text)
returns table (household_id uuid, revision bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_household_id uuid;
begin
  if v_user_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if coalesce(char_length(p_invite_token), 0) < 43 then
    raise exception 'invalid invite token' using errcode = '22023';
  end if;

  select invite.household_id
  into v_household_id
  from public.household_invites invite
  where invite.token_hash = encode(extensions.digest(convert_to(p_invite_token, 'UTF8'), 'sha256'), 'hex')
    and invite.revoked_at is null
  limit 1;

  if v_household_id is null then
    raise exception 'invalid or revoked invite' using errcode = '28000';
  end if;

  insert into public.household_members (household_id, user_id)
  values (v_household_id, v_user_id)
  on conflict do nothing;

  return query
    select sync_state.household_id, sync_state.revision
    from public.household_states sync_state
    where sync_state.household_id = v_household_id;
end;
$$;

create or replace function public.get_my_household()
returns table (household_id uuid, revision bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select member.household_id, sync_state.revision
  from public.household_members member
  join public.household_states sync_state on sync_state.household_id = member.household_id
  where member.user_id = (select auth.uid())
  order by member.joined_at
  limit 1;
$$;

create or replace function public.save_household_state(
  p_household_id uuid,
  p_expected_revision bigint,
  p_state jsonb
)
returns table (saved boolean, current_revision bigint, current_state jsonb)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_revision bigint;
  v_state jsonb;
begin
  if v_user_id is null or not public.is_household_member(p_household_id) then
    raise exception 'household access denied' using errcode = '42501';
  end if;
  if jsonb_typeof(p_state) is distinct from 'object' then
    raise exception 'state must be a JSON object' using errcode = '22023';
  end if;
  if pg_column_size(p_state) > 5242880 then
    raise exception 'state is too large' using errcode = '22001';
  end if;

  select sync_state.revision, sync_state.state
  into v_revision, v_state
  from public.household_states sync_state
  where sync_state.household_id = p_household_id
  for update;

  if v_revision is null then
    raise exception 'household state not found' using errcode = 'P0002';
  end if;

  if v_revision <> p_expected_revision then
    return query select false, v_revision, v_state;
    return;
  end if;

  update public.household_states sync_state
  set state = p_state,
      revision = sync_state.revision + 1,
      updated_at = now(),
      updated_by = v_user_id
  where sync_state.household_id = p_household_id
  returning sync_state.revision, sync_state.state into v_revision, v_state;

  return query select true, v_revision, v_state;
end;
$$;

revoke all on function public.create_household(text, text, jsonb) from public, anon;
revoke all on function public.join_household(text) from public, anon;
revoke all on function public.get_my_household() from public, anon;
revoke all on function public.save_household_state(uuid, bigint, jsonb) from public, anon;
grant execute on function public.create_household(text, text, jsonb) to authenticated;
grant execute on function public.join_household(text) to authenticated;
grant execute on function public.get_my_household() to authenticated;
grant execute on function public.save_household_state(uuid, bigint, jsonb) to authenticated;

-- Postgres Changes をこの1テーブルだけ有効化する。
do $$
begin
  alter publication supabase_realtime add table public.household_states;
exception
  when duplicate_object then null;
end $$;

alter table public.household_states replica identity full;
