-- ============================================================================
-- 0016 · Presence (online / away / offline / driving, last active)
--
-- One row per user, written only by the API from the app's heartbeat. The
-- status shown to friends is DERIVED from timestamps when read
-- (private.presence_status), so a phone that crashes, dies or loses signal
-- drifts to Away and then Offline by itself: no cleanup job, no stale
-- "Online" or "Driving".
--
-- Who may see it (private.can_see_presence): the owner, and friends while
-- neither has blocked the other and the owner's show_activity_status is on.
-- Presence deliberately does not live on `profiles`, which every signed-in,
-- non-blocked user may read.
--
-- No live location here: that is a later, separate table.
-- ============================================================================

-- ─── Privacy setting ─────────────────────────────────────────────────────────
alter table public.user_settings
  add column show_activity_status boolean not null default true;

-- The client write guard (0015) lists the settings a client may change.
drop trigger user_settings_client_guard on public.user_settings;
create trigger user_settings_client_guard before update on public.user_settings
  for each row execute function private.guard_client_update(
    'unit_system', 'profile_visibility', 'default_journey_visibility', 'default_location_visibility',
    'allow_friend_requests', 'share_live_location_in_convoys', 'notification_prefs',
    'show_activity_status');

-- ─── user_presence ───────────────────────────────────────────────────────────
-- app_state is what the app last reported (on screen, in the background, or
-- signed out). It is stored because "just went to the background" (Away) and
-- "signed out" (Offline) can't be told from a timestamp; everything else is
-- derived from last_seen_at.
create table public.user_presence (
  user_id      uuid        primary key references public.profiles (id) on delete cascade,
  app_state    text        not null default 'foreground',
  driving      boolean     not null default false,
  journey_id   uuid        references public.journeys (id) on delete set null,
  last_seen_at timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint user_presence_app_state      check (app_state in ('foreground', 'background', 'signed_out')),
  constraint user_presence_journey_driving check (journey_id is null or driving),
  constraint user_presence_signed_out     check (app_state <> 'signed_out' or not driving)
);

create trigger user_presence_set_updated_at
  before update on public.user_presence
  for each row execute function private.set_updated_at();

alter table public.user_presence enable row level security;

-- ─── Derived status ──────────────────────────────────────────────────────────
-- Driving  driving, and heard from within 3 minutes (background heartbeats
--          continue during a drive, so a locked phone stays Driving)
-- Online   on screen, heard from within 2 minutes
-- Away     in the background, or last heard from 2–10 minutes ago
-- Offline  signed out, never heard from, or nothing for over 10 minutes
-- Driving takes priority. p_now is a parameter so tests can move the clock.
create function private.presence_status(
  p_app_state text, p_driving boolean, p_last_seen_at timestamptz, p_now timestamptz default now())
returns text
language sql stable
set search_path = ''
as $$
  select case
    when p_last_seen_at is null or p_app_state is null or p_app_state = 'signed_out' then 'offline'
    when p_driving and p_now - p_last_seen_at <= interval '3 minutes' then 'driving'
    when p_now - p_last_seen_at > interval '10 minutes' then 'offline'
    when p_app_state = 'foreground' and p_now - p_last_seen_at <= interval '2 minutes' then 'online'
    else 'away'
  end
$$;

-- ─── Visibility ──────────────────────────────────────────────────────────────
-- Same conventions as the 0011 helpers: SECURITY DEFINER, evaluated for the
-- signed-in user (auth.uid()), false when nobody is signed in.
create function private.can_see_presence(p_owner uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select case
    when (select auth.uid()) is null or p_owner is null then false
    when p_owner = (select auth.uid()) then true
    when not private.is_friend(p_owner, (select auth.uid())) then false
    when private.is_blocked_between(p_owner, (select auth.uid())) then false
    else coalesce((select s.show_activity_status from public.user_settings s where s.user_id = p_owner), false)
  end
$$;

revoke execute on function private.presence_status(text, boolean, timestamptz, timestamptz) from public, anon, authenticated;
revoke execute on function private.can_see_presence(uuid) from public, anon, authenticated;
-- Policies run as the querying role, which therefore needs EXECUTE.
grant execute on function private.can_see_presence(uuid) to authenticated;
grant execute on function private.presence_status(text, boolean, timestamptz, timestamptz) to authenticated;

-- ─── Policies ────────────────────────────────────────────────────────────────
-- Read: owner, or a friend allowed by can_see_presence. Writes are server-only
-- (no insert/update/delete policy): the API checks that a journey_id is the
-- caller's own active drive and stamps last_seen_at with the server's clock.
create policy user_presence_select on public.user_presence
  for select to authenticated
  using (private.can_see_presence(user_id));

-- Belt and braces, as in 0012: no client role holds privileges on it yet.
revoke all on public.user_presence from anon, authenticated;

-- ─── A finished drive is no longer "driving" ─────────────────────────────────
-- If the app couldn't report the end of a drive (offline, killed), completing
-- the journey on the server clears it. Only that journey: a later drive
-- already reported is left alone.
create function private.clear_presence_on_journey_end()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  update public.user_presence
     set driving = false, journey_id = null
   where user_id = new.owner_id and journey_id = new.id;
  return new;
end;
$$;

revoke execute on function private.clear_presence_on_journey_end() from public, anon, authenticated;

create trigger journeys_clear_presence
  after update of status on public.journeys
  for each row when (new.status is distinct from 'active' and old.status = 'active')
  execute function private.clear_presence_on_journey_end();
