-- ============================================================================
-- 0018 · Private live location
--
-- A user's current position, shared only with people they explicitly allow,
-- only while they choose, and never kept as history.
--
-- WHEN (user_settings.location_sharing):  off · while_driving · while_using
--   ('always' — background sharing outside a drive — is deliberately not
--   allowed yet: it needs native background permission work first.)
-- WHO, the union of private grants (each still needs the WHEN to allow it):
--   * friends (user_settings.location_friend_audience): none · selected · all
--     - 'selected': the friends listed in location_share_friends
--     - a friend grant needs a friendship that still exists
--   * Convoys the owner has turned on (location_share_convoys), seen by the
--     Convoy's other members, while the owner is still a member too.
--     Only private Convoys that no Community is linked to count: those are
--     joined only by the leader's code. Public Convoys (anyone can join) and
--     Community-linked ones (any Community member can join) never grant
--     location, nor do Convoys that are over (completed or cancelled). Being a member never shares by itself.
-- Community (group) membership never grants anything.
-- A block in either direction overrides every grant.
--
-- One canonical rule, private.can_see_live_location(owner, viewer), is used
-- by the RLS policy (through a wrapper fixed to the signed-in user), by the
-- API's snapshot (which connects as the table owner, so it calls the function
-- explicitly) and by the Realtime fan-out.
--
-- live_locations holds one row per user, overwritten on every update, with
-- an expiry: reads treat an expired row as absent whether or not the clean-up
-- has deleted it. Updates and revocations reach viewers through the private
-- inbox from 0017 (event 'live_location').
-- ============================================================================

-- ─── Settings ────────────────────────────────────────────────────────────────
alter table public.user_settings
  add column location_sharing         text not null default 'off',
  add column location_friend_audience text not null default 'none',
  add constraint user_settings_location_sharing check (location_sharing in ('off', 'while_driving', 'while_using')),
  add constraint user_settings_location_friend_audience check (location_friend_audience in ('none', 'selected', 'all'));

comment on column public.user_settings.share_live_location_in_convoys is
  'Deprecated (0018): never used for authorisation. Convoy sharing is per Convoy in location_share_convoys.';

-- Clients may change these directly too (the API is the normal path).
drop trigger user_settings_client_guard on public.user_settings;
create trigger user_settings_client_guard before update on public.user_settings
  for each row execute function private.guard_client_update(
    'unit_system', 'profile_visibility', 'default_journey_visibility', 'default_location_visibility',
    'allow_friend_requests', 'share_live_location_in_convoys', 'notification_prefs',
    'show_activity_status', 'location_sharing', 'location_friend_audience');

-- ─── Grants ──────────────────────────────────────────────────────────────────
-- Selected friends. Only meaningful while the friendship exists (checked on
-- every read); removed when the friendship ends or either blocks the other.
create table public.location_share_friends (
  owner_id   uuid        not null references public.profiles (id) on delete cascade,
  friend_id  uuid        not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (owner_id, friend_id),
  constraint location_share_friends_not_self check (owner_id <> friend_id)
);
create index location_share_friends_friend_idx on public.location_share_friends (friend_id);
alter table public.location_share_friends enable row level security;

-- Convoys the owner shares with. Removed when the owner leaves the Convoy.
create table public.location_share_convoys (
  owner_id   uuid        not null references public.profiles (id) on delete cascade,
  convoy_id  uuid        not null references public.convoys (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (owner_id, convoy_id)
);
create index location_share_convoys_convoy_idx on public.location_share_convoys (convoy_id);
alter table public.location_share_convoys enable row level security;

-- ─── Current position (not history) ──────────────────────────────────────────
-- Written only by the API. Coordinates are stored to 5 decimal places
-- (about 1 m): enough for a map marker, no more. `driving` comes from the
-- owner's presence on the server, not from the client.
create table public.live_locations (
  user_id     uuid             primary key references public.profiles (id) on delete cascade,
  latitude    double precision not null,
  longitude   double precision not null,
  heading_deg real,
  speed_kmh   real,
  accuracy_m  real,
  driving     boolean          not null default false,
  recorded_at timestamptz      not null default now(),
  expires_at  timestamptz      not null,

  constraint live_locations_latitude  check (latitude between -90 and 90),
  constraint live_locations_longitude check (longitude between -180 and 180),
  constraint live_locations_heading   check (heading_deg is null or (heading_deg >= 0 and heading_deg < 360)),
  constraint live_locations_speed     check (speed_kmh is null or (speed_kmh >= 0 and speed_kmh <= 400)),
  constraint live_locations_accuracy  check (accuracy_m is null or accuracy_m >= 0),
  constraint live_locations_expiry    check (expires_at > recorded_at and expires_at <= recorded_at + interval '10 minutes')
);
create index live_locations_expires_idx on public.live_locations (expires_at);
alter table public.live_locations enable row level security;

-- ─── The canonical rule ──────────────────────────────────────────────────────
-- Whether owner has granted viewer access at all (WHO, and WHEN is not
-- 'off'), ignoring whether a current position exists. Every branch is a
-- private relationship; nothing here mentions groups (Communities).
create function private.live_location_granted(p_owner uuid, p_viewer uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select p_owner is not null and p_viewer is not null and p_owner <> p_viewer
    and not private.is_blocked_between(p_owner, p_viewer)
    and exists (
      select 1 from public.user_settings s
      where s.user_id = p_owner and s.location_sharing in ('while_driving', 'while_using')
        and (
          -- friends
          (
            private.is_friend(p_owner, p_viewer)
            and (
              s.location_friend_audience = 'all'
              or (s.location_friend_audience = 'selected' and exists (
                    select 1 from public.location_share_friends g
                    where g.owner_id = p_owner and g.friend_id = p_viewer))
            )
          )
          -- Convoys the owner turned on, both still members, Convoy private,
          -- not Community-linked, not over
          or exists (
            select 1
              from public.location_share_convoys g
              join public.convoys c on c.id = g.convoy_id
              join public.convoy_participants po on po.convoy_id = c.id and po.user_id = p_owner
              join public.convoy_participants pv on pv.convoy_id = c.id and pv.user_id = p_viewer
             where g.owner_id = p_owner
               and c.visibility = 'private' and c.group_id is null and c.status in ('forming', 'active')
          )
        )
    )
$$;

-- Whether viewer may see owner's live location right now: a grant, a
-- current (unexpired) position, and the owner's WHEN satisfied by it.
create function private.can_see_live_location(p_owner uuid, p_viewer uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select private.live_location_granted(p_owner, p_viewer)
    and exists (
      select 1 from public.live_locations l
      join public.user_settings s on s.user_id = l.user_id
      where l.user_id = p_owner and l.expires_at > now()
        and (s.location_sharing = 'while_using' or l.driving)
    )
$$;

-- People who might be granted: friends and fellow members of the owner's
-- shared Convoys. Callers filter with live_location_granted.
create function private.live_location_candidates(p_owner uuid)
returns setof uuid
language sql stable security definer
set search_path = ''
as $$
  select f.friend_id from public.friendships f where f.user_id = p_owner
  union
  select pv.user_id
    from public.location_share_convoys g
    join public.convoy_participants pv on pv.convoy_id = g.convoy_id
   where g.owner_id = p_owner and pv.user_id <> p_owner
$$;

-- ─── Fan-out over the private inbox (0017) ───────────────────────────────────
create function private.inbox_send_live(p_recipient uuid, p_payload jsonb)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  perform realtime.send(p_payload, 'live_location', 'inbox:' || p_recipient::text, true);
end;
$$;

-- The owner's position to every granted viewer with the app open.
create function private.publish_live_location(p_owner uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  l       public.live_locations;
  payload jsonb;
  viewer  uuid;
begin
  select * into l from public.live_locations where user_id = p_owner and expires_at > now();
  if not found then return; end if;
  payload := jsonb_build_object(
    'type', 'live_location', 'userId', p_owner,
    'latitude', l.latitude, 'longitude', l.longitude,
    'headingDeg', l.heading_deg, 'speedKmh', l.speed_kmh, 'accuracyM', l.accuracy_m,
    'driving', l.driving,
    'recordedAt', to_char(l.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expiresAt', to_char(l.expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  for viewer in
    select c from private.live_location_candidates(p_owner) c
      join public.user_presence vp on vp.user_id = c
     where vp.app_state = 'foreground' and vp.last_seen_at > now() - interval '3 minutes'
  loop
    if private.can_see_live_location(p_owner, viewer) then
      perform private.inbox_send_live(viewer, payload);
    end if;
  end loop;
end;
$$;

-- "Remove p_owner's location" to every viewer in p_viewers who may no longer
-- see it (a viewer still granted another way keeps it). Sent whether or not
-- their app is open, so no cached position survives.
create function private.revoke_live_location(p_owner uuid, p_viewers uuid[])
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  viewer uuid;
begin
  foreach viewer in array coalesce(p_viewers, '{}') loop
    if viewer is not null and viewer <> p_owner and not private.can_see_live_location(p_owner, viewer) then
      perform private.inbox_send_live(viewer, jsonb_build_object('type', 'live_location_hidden', 'userId', p_owner));
    end if;
  end loop;
end;
$$;

-- Everyone who could have been seeing p_owner (friends and fellow members of
-- any Convoy p_owner is in) is re-checked. With no position stored there is
-- nothing anyone could be showing (deleting it already told them).
create function private.reconcile_live_location(p_owner uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.live_locations where user_id = p_owner) then
    return;
  end if;
  perform private.revoke_live_location(p_owner, array(
    select f.friend_id from public.friendships f where f.user_id = p_owner
    union
    select pv.user_id from public.convoy_participants po
      join public.convoy_participants pv on pv.convoy_id = po.convoy_id
     where po.user_id = p_owner and pv.user_id <> p_owner));
  perform private.publish_live_location(p_owner);
end;
$$;

-- ─── Triggers ────────────────────────────────────────────────────────────────
create function private.on_live_location_change()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    -- Stopped sharing, expired and cleaned up, or account deleted: everyone
    -- who could see it drops it.
    perform private.revoke_live_location(old.user_id, array(
      select f.friend_id from public.friendships f where f.user_id = old.user_id
      union
      select pv.user_id from public.convoy_participants po
        join public.convoy_participants pv on pv.convoy_id = po.convoy_id
       where po.user_id = old.user_id and pv.user_id <> old.user_id));
    return null;
  end if;
  perform private.publish_live_location(new.user_id);
  return null;
end;
$$;
create trigger live_locations_publish
  after insert or update or delete on public.live_locations
  for each row execute function private.on_live_location_change();

-- WHEN or WHO changed. Turning sharing off also deletes the position.
create function private.on_location_settings_change()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.location_sharing = 'off' then
    delete from public.live_locations where user_id = new.user_id;
  end if;
  perform private.reconcile_live_location(new.user_id);
  return null;
end;
$$;
create trigger user_settings_live_location
  after update of location_sharing, location_friend_audience on public.user_settings
  for each row when (old.location_sharing is distinct from new.location_sharing
                     or old.location_friend_audience is distinct from new.location_friend_audience)
  execute function private.on_location_settings_change();

-- A selected friend removed (or added: they get the position at once).
create function private.on_location_share_friend_change()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    perform private.revoke_live_location(old.owner_id, array[old.friend_id]);
  else
    perform private.publish_live_location(new.owner_id);
  end if;
  return null;
end;
$$;
create trigger location_share_friends_publish
  after insert or delete on public.location_share_friends
  for each row execute function private.on_location_share_friend_change();

-- A Convoy turned off for sharing: its members are re-checked.
create function private.on_location_share_convoy_change()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    perform private.revoke_live_location(old.owner_id, array(
      select pv.user_id from public.convoy_participants pv where pv.convoy_id = old.convoy_id));
  else
    perform private.publish_live_location(new.owner_id);
  end if;
  return null;
end;
$$;
create trigger location_share_convoys_publish
  after insert or delete on public.location_share_convoys
  for each row execute function private.on_location_share_convoy_change();

-- Someone left or was removed from a Convoy: their own sharing with it ends,
-- and anyone who saw them, or whom they saw, only through it is re-checked.
create function private.on_convoy_participant_removed()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  member uuid;
begin
  delete from public.location_share_convoys where owner_id = old.user_id and convoy_id = old.convoy_id;
  for member in select g.owner_id from public.location_share_convoys g where g.convoy_id = old.convoy_id loop
    perform private.revoke_live_location(member, array[old.user_id]);
  end loop;
  return null;
end;
$$;
create trigger convoy_participants_live_location
  after delete on public.convoy_participants
  for each row execute function private.on_convoy_participant_removed();

-- A Convoy made public, linked to a Community, completed or cancelled stops granting.
create function private.on_convoy_access_change()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  member uuid;
begin
  for member in select g.owner_id from public.location_share_convoys g where g.convoy_id = new.id loop
    perform private.revoke_live_location(member, array(
      select pv.user_id from public.convoy_participants pv where pv.convoy_id = new.id));
  end loop;
  return null;
end;
$$;
create trigger convoys_live_location
  after update of visibility, group_id, status on public.convoys
  for each row when (old.visibility is distinct from new.visibility
                     or old.group_id is distinct from new.group_id
                     or old.status is distinct from new.status)
  execute function private.on_convoy_access_change();

-- A Convoy deleted outright: its grants are removed first, while its members
-- are still listed, so each member is re-checked and told. (Left to the
-- cascades, the grants and members could go in either order and nobody
-- would be told.)
create function private.on_convoy_deleting()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  delete from public.location_share_convoys where convoy_id = old.id;
  return old;
end;
$$;
create trigger convoys_live_location_delete
  before delete on public.convoys
  for each row execute function private.on_convoy_deleting();

-- An account deleted: its position goes first, while its friendships and
-- Convoys are still there to say who must be told (not left to the order in
-- which the cascades happen to run).
create function private.on_profile_deleting_live()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  delete from public.live_locations where user_id = old.id;
  return old;
end;
$$;
create trigger profiles_live_location_delete
  before delete on public.profiles
  for each row execute function private.on_profile_deleting_live();

-- A friendship ended: the selected-friend grant goes with it (it never
-- outlives the friendship), and the ex-friend is re-checked (a shared Convoy
-- may still grant access).
create function private.on_friendship_removed_live()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  delete from public.location_share_friends
   where (owner_id = old.user_id and friend_id = old.friend_id)
      or (owner_id = old.friend_id and friend_id = old.user_id);
  perform private.revoke_live_location(old.friend_id, array[old.user_id]);
  return null;
end;
$$;
create trigger friendships_live_location
  after delete on public.friendships
  for each row execute function private.on_friendship_removed_live();

-- A block, either way, ends everything between the two at once.
create function private.on_block_live()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  delete from public.location_share_friends
   where (owner_id = new.blocker_id and friend_id = new.blocked_id)
      or (owner_id = new.blocked_id and friend_id = new.blocker_id);
  perform private.revoke_live_location(new.blocker_id, array[new.blocked_id]);
  perform private.revoke_live_location(new.blocked_id, array[new.blocker_id]);
  return null;
end;
$$;
create trigger user_blocks_live_location
  after insert on public.user_blocks
  for each row execute function private.on_block_live();

-- The owner's presence changed (0016): the server, not the app, ends sharing
-- that no longer applies, so a failed "stop" from the phone can't leave a
-- stale position visible.
--   signed out                         -> position removed
--   drive ended, sharing while_driving -> position removed
--   drive ended, sharing while_using   -> no longer shown as driving
--   app backgrounded, not driving      -> position removed (not "using")
create function private.on_presence_live_location()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  mode text := (select s.location_sharing from public.user_settings s where s.user_id = new.user_id);
begin
  if not exists (select 1 from public.live_locations where user_id = new.user_id) then
    return null;
  end if;
  if new.app_state = 'signed_out'
     or (not new.driving and (mode is distinct from 'while_using' or new.app_state = 'background')) then
    delete from public.live_locations where user_id = new.user_id;
  elsif old.driving and not new.driving then
    update public.live_locations set driving = false where user_id = new.user_id;
  end if;
  return null;
end;
$$;
create trigger user_presence_live_location
  after update of app_state, driving on public.user_presence
  for each row when (old.app_state is distinct from new.app_state or old.driving is distinct from new.driving)
  execute function private.on_presence_live_location();

-- ─── Privileges and policies ─────────────────────────────────────────────────
revoke execute on function
  private.live_location_granted(uuid, uuid), private.can_see_live_location(uuid, uuid),
  private.live_location_candidates(uuid), private.inbox_send_live(uuid, jsonb),
  private.publish_live_location(uuid), private.revoke_live_location(uuid, uuid[]),
  private.reconcile_live_location(uuid), private.on_live_location_change(),
  private.on_location_settings_change(), private.on_location_share_friend_change(),
  private.on_location_share_convoy_change(), private.on_convoy_participant_removed(),
  private.on_convoy_access_change(), private.on_convoy_deleting(), private.on_profile_deleting_live(), private.on_friendship_removed_live(), private.on_block_live(),
  private.on_presence_live_location()
from public, anon, authenticated;

-- The read policy runs as the querying role, so that role needs EXECUTE on
-- what it calls. It gets only this wrapper, which always asks about the
-- signed-in user themselves: nobody can ask the canonical rule about some
-- other pair of people (who shares with whom).
create function private.can_see_live_location_as_me(p_owner uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
     and private.can_see_live_location(p_owner, (select auth.uid()))
$$;
revoke execute on function private.can_see_live_location_as_me(uuid) from public, anon, authenticated;
grant execute on function private.can_see_live_location_as_me(uuid) to authenticated;

revoke all on public.live_locations, public.location_share_friends, public.location_share_convoys from anon, authenticated;

-- Positions: the owner, or a viewer the canonical rule allows right now.
-- Writes are server-only (the API checks WHEN, stamps the time and expiry,
-- and takes `driving` from the owner's presence).
create policy live_locations_select on public.live_locations
  for select to authenticated
  using (
    (user_id = (select auth.uid()) and expires_at > now())
    or private.can_see_live_location_as_me(user_id)
  );

-- Grants are private to their owner; writes go through the API, which
-- checks friendship and Convoy eligibility.
create policy location_share_friends_select_own on public.location_share_friends
  for select to authenticated using (owner_id = (select auth.uid()));
create policy location_share_convoys_select_own on public.location_share_convoys
  for select to authenticated using (owner_id = (select auth.uid()));
