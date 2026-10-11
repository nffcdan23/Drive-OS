-- ============================================================================
-- 0020 · Live road hazards
--
-- Drivers report temporary hazards (an accident, an obstruction, a broken-
-- down vehicle, roadworks, flooding, police) at their current position;
-- other drivers nearby see them on the Drive map and can say "Still there"
-- or "Not there".
--
-- Anonymous to everyone else: public.road_hazards has no user column at all.
-- Who reported or voted is kept only in public.road_hazard_votes (one row per
-- person per hazard), which each user may read only for themselves, and
-- which exists for duplicate and abuse protection.
--
-- Temporary by construction: every hazard has an expiry set from its kind
-- (private.hazard_lifetime), extended modestly by confirmations and never
-- past a hard cap. Every read treats an expired or removed hazard as absent,
-- whether or not the clean-up has deleted it yet, so correctness never
-- depends on clean-up.
--
-- Every change goes through the functions below, run by the API (which
-- connects as the table owner): clients hold no privileges, and the policies
-- allow reads only (active hazards; your own votes). Nothing lets a client
-- set coordinates, someone else's vote, counts or an expiry, or revive an
-- expired hazard.
--
-- Realtime: each hazard belongs to one coarse area (a 0.5° grid cell). New,
-- confirmed and removed hazards are broadcast on that area's topic
-- (`hazards:<lat cell>:<lng cell>`) with realtime.send, the same database-
-- sent broadcast as the private inbox (0017). Any signed-in user may receive
-- on an area topic; nobody may publish. Payloads carry only what the map
-- shows: no user, ever.
-- ============================================================================

do $$
begin
  if to_regclass('realtime.messages') is null or to_regprocedure('realtime.send(jsonb, text, text, boolean)') is null then
    raise exception 'Supabase Realtime (realtime.messages, realtime.send) is not available on this database';
  end if;
end;
$$;

-- ─── Kinds: the one place their timings live ────────────────────────────────
-- Adding a kind: a new migration extends road_hazards_kind and these three
-- functions. The app shows any kind it doesn't know as a generic hazard.

-- How long a fresh report stays up
create function private.hazard_lifetime(p_kind text)
returns interval
language sql immutable
set search_path = ''
as $$
  select case p_kind
    when 'accident'    then interval '60 minutes'
    when 'hazard'      then interval '45 minutes'
    when 'broken_down' then interval '45 minutes'
    when 'police'      then interval '30 minutes'
    when 'roadworks'   then interval '6 hours'
    when 'flooding'    then interval '4 hours'
  end
$$;

-- The longest a hazard can stay up however often it is confirmed: three
-- times its lifetime (accident 3 h, police 90 min, roadworks 18 h)
create function private.hazard_max_lifetime(p_kind text)
returns interval
language sql immutable
set search_path = ''
as $$
  select private.hazard_lifetime(p_kind) * 3
$$;

-- A second report of the same kind this close to an active one confirms it
-- rather than adding another marker. Roadworks and flooding cover more road.
create function private.hazard_merge_radius_m(p_kind text)
returns double precision
language sql immutable
set search_path = ''
as $$
  select case when p_kind in ('roadworks', 'flooding') then 300.0 else 150.0 end
$$;

-- The Realtime area a position belongs to (0.5° cells, about 55 × 35 km in
-- the UK)
create function private.hazard_topic(p_lat double precision, p_lng double precision)
returns text
language sql immutable
set search_path = ''
as $$
  select 'hazards:' || floor(p_lat * 2)::int::text || ':' || floor(p_lng * 2)::int::text
$$;

-- ─── Tables ──────────────────────────────────────────────────────────────────
create table public.road_hazards (
  id                uuid             primary key default gen_random_uuid(),
  kind              text             not null,
  -- 5 decimal places (about a metre), set by the API from the reporter's fix
  latitude          double precision not null,
  longitude         double precision not null,
  geog              extensions.geography(Point, 4326) not null
                    generated always as (
                      extensions.st_setsrid(extensions.st_makepoint(longitude, latitude), 4326)::extensions.geography
                    ) stored,
  created_at        timestamptz      not null default now(),
  -- The latest report or "Still there"
  last_confirmed_at timestamptz      not null default now(),
  expires_at        timestamptz      not null,
  -- Reports (the first and any merged duplicates) plus "Still there" votes
  support           integer          not null default 1,
  -- "Not there" votes
  dismissals        integer          not null default 0,
  -- Set when enough drivers say it's gone (never deleted for that)
  removed_at        timestamptz,

  constraint road_hazards_kind      check (kind in ('accident', 'hazard', 'broken_down', 'roadworks', 'flooding', 'police')),
  constraint road_hazards_latitude  check (latitude between -90 and 90),
  constraint road_hazards_longitude check (longitude between -180 and 180),
  constraint road_hazards_counts    check (support >= 1 and dismissals >= 0),
  constraint road_hazards_expiry    check (expires_at > created_at and expires_at <= created_at + interval '24 hours')
);
create index road_hazards_geog_idx on public.road_hazards using gist (geog);
create index road_hazards_expires_idx on public.road_hazards (expires_at);
alter table public.road_hazards enable row level security;

-- One row per person per hazard: their report, or their vote. Final: a
-- person can't vote twice on one hazard or change their vote.
create table public.road_hazard_votes (
  hazard_id  uuid        not null references public.road_hazards (id) on delete cascade,
  user_id    uuid        not null references public.profiles (id) on delete cascade,
  vote       text        not null,
  created_at timestamptz not null default now(),
  primary key (hazard_id, user_id),
  constraint road_hazard_votes_vote check (vote in ('reported', 'still_there', 'not_there'))
);
create index road_hazard_votes_user_idx on public.road_hazard_votes (user_id, created_at);
alter table public.road_hazard_votes enable row level security;

-- ─── What everyone may see ───────────────────────────────────────────────────
-- Active: not expired, not removed. Every read uses this.
create function private.hazard_is_active(h public.road_hazards)
returns boolean
language sql stable
set search_path = ''
as $$
  select h.expires_at > now() and h.removed_at is null
$$;

-- A hazard as the map shows it: no user, ever. `expiresInMs` is by the
-- server's clock, so the app drops it on time whatever its own clock says.
create function private.hazard_public_json(h public.road_hazards)
returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', h.id,
    'kind', h.kind,
    'latitude', h.latitude,
    'longitude', h.longitude,
    'reportedAt', to_char(h.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'lastConfirmedAt', to_char(h.last_confirmed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expiresAt', to_char(h.expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expiresInMs', greatest(0, floor(extract(epoch from (h.expires_at - clock_timestamp())) * 1000))::bigint,
    'confirmations', h.support - 1)
$$;

-- ─── Changes (the API only) ──────────────────────────────────────────────────
-- Limits, enforced here so they hold however many API instances run:
--   reports (new or merged):          5 per 10 minutes, 30 per day
--   "Still there" / "Not there":      20 per 10 minutes
create function private.hazard_extended_expiry(h public.road_hazards)
returns timestamptz
language sql stable
set search_path = ''
as $$
  -- Half a lifetime from now, never shorter than it already was, never past
  -- the cap
  select least(h.created_at + private.hazard_max_lifetime(h.kind),
               greatest(h.expires_at, now() + private.hazard_lifetime(h.kind) / 2))
$$;

-- Report a hazard at the reporter's position. Outcomes:
--   created           a new hazard
--   merged            the same kind is already reported this close: it is
--                     confirmed (by this report) instead
--   already_reported  this person already reported or confirmed that one:
--                     nothing changes (no repeated boosting)
--   rate_limited      too many reports lately
create function private.report_hazard(p_user uuid, p_kind text, p_lat double precision, p_lng double precision)
returns table (hazard_id uuid, outcome text)
language plpgsql security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  here     extensions.geography;
  nearest  uuid;
  existing public.road_hazards;
  mine     text;
  created  uuid;
begin
  if p_user is null or private.hazard_lifetime(p_kind) is null
     or p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    raise exception 'invalid hazard report' using errcode = '22023';
  end if;
  -- One report at a time per person (the limits below can't be raced), then
  -- one at a time per kind and area (two drivers reporting the same thing at
  -- once make one marker)
  perform pg_advisory_xact_lock(hashtextextended('driveos.hazard_reporter:' || p_user::text, 0));
  perform pg_advisory_xact_lock(hashtextextended(
    'driveos.hazard_area:' || p_kind || ':' || floor(p_lat * 20)::text || ':' || floor(p_lng * 20)::text, 0));

  if (select count(*) from public.road_hazard_votes v
       where v.user_id = p_user and v.vote = 'reported' and v.created_at > now() - interval '10 minutes') >= 5
     or (select count(*) from public.road_hazard_votes v
       where v.user_id = p_user and v.vote = 'reported' and v.created_at > now() - interval '1 day') >= 30 then
    return query select null::uuid, 'rate_limited'::text;
    return;
  end if;

  here := extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography;
  -- The nearest active one, then locked by id (and checked again: the area
  -- lock above already keeps other reports of this kind out)
  select h.id into nearest
    from public.road_hazards h
   where h.kind = p_kind and h.expires_at > now() and h.removed_at is null
     and extensions.st_dwithin(h.geog, here, private.hazard_merge_radius_m(p_kind))
   order by h.geog operator(extensions.<->) here
   limit 1;
  if nearest is not null then
    select * into existing from public.road_hazards where id = nearest for update;
  end if;

  if nearest is not null and private.hazard_is_active(existing) then
    select v.vote into mine from public.road_hazard_votes v where v.hazard_id = existing.id and v.user_id = p_user;
    if mine in ('reported', 'still_there') then
      return query select existing.id, 'already_reported'::text;
      return;
    end if;
    if mine = 'not_there' then
      -- They said it was gone; now they see it: their vote becomes a report
      update public.road_hazard_votes set vote = 'reported', created_at = now()
       where road_hazard_votes.hazard_id = existing.id and user_id = p_user;
      update public.road_hazards h
         set support = h.support + 1, dismissals = h.dismissals - 1, last_confirmed_at = now(),
             expires_at = private.hazard_extended_expiry(h)
       where h.id = existing.id;
    else
      insert into public.road_hazard_votes (hazard_id, user_id, vote) values (existing.id, p_user, 'reported');
      update public.road_hazards h
         set support = h.support + 1, last_confirmed_at = now(), expires_at = private.hazard_extended_expiry(h)
       where h.id = existing.id;
    end if;
    return query select existing.id, 'merged'::text;
    return;
  end if;

  insert into public.road_hazards (kind, latitude, longitude, expires_at)
  values (p_kind, round(p_lat::numeric, 5)::float8, round(p_lng::numeric, 5)::float8, now() + private.hazard_lifetime(p_kind))
  returning id into created;
  insert into public.road_hazard_votes (hazard_id, user_id, vote) values (created, p_user, 'reported');
  return query select created, 'created'::text;
end;
$$;

-- "Still there" or "Not there" on an active hazard. Outcomes:
--   counted        the vote was counted
--   already_voted  this person already voted on it (votes are final)
--   own_report     this person reported it (they can't confirm their own)
--   not_found      no such active hazard (expired or removed ones can't be
--                  voted back)
--   rate_limited   too many votes lately
-- "Still there" extends its life modestly (up to the cap). It is removed only
-- when at least two people say "Not there" and they outnumber its support
-- (its reports and "Still there" votes): one person can't clear it.
create function private.vote_hazard(p_user uuid, p_hazard uuid, p_vote text)
returns text
language plpgsql security definer
set search_path = ''
as $$
declare
  h    public.road_hazards;
  mine text;
begin
  if p_user is null or p_hazard is null or p_vote is null or p_vote not in ('still_there', 'not_there') then
    raise exception 'invalid hazard vote' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('driveos.hazard_reporter:' || p_user::text, 0));
  select * into h from public.road_hazards where id = p_hazard for update;
  if not found or not private.hazard_is_active(h) then
    return 'not_found';
  end if;
  select v.vote into mine from public.road_hazard_votes v where v.hazard_id = p_hazard and v.user_id = p_user;
  if mine = 'reported' then
    return 'own_report';
  elsif mine is not null then
    return 'already_voted';
  end if;
  if (select count(*) from public.road_hazard_votes v
       where v.user_id = p_user and v.vote in ('still_there', 'not_there')
         and v.created_at > now() - interval '10 minutes') >= 20 then
    return 'rate_limited';
  end if;

  insert into public.road_hazard_votes (hazard_id, user_id, vote) values (p_hazard, p_user, p_vote);
  if p_vote = 'still_there' then
    update public.road_hazards r
       set support = r.support + 1, last_confirmed_at = now(), expires_at = private.hazard_extended_expiry(r)
     where r.id = p_hazard;
  else
    update public.road_hazards r
       set dismissals = r.dismissals + 1,
           removed_at = case when r.dismissals + 1 >= 2 and r.dismissals + 1 > r.support then now() else null end
     where r.id = p_hazard;
  end if;
  return 'counted';
end;
$$;

-- Active hazards in a map area, nearest the centre first, with the caller's
-- own vote (or report) so the app knows what they've already said. Never
-- who else reported or voted. The area is capped (about 110 × 110 km) and so
-- is the count.
create function private.hazards_in_view(
  p_viewer  uuid,
  p_min_lat double precision,
  p_min_lng double precision,
  p_max_lat double precision,
  p_max_lng double precision,
  p_limit   integer default 200
)
returns table (hazard jsonb, my_vote text)
language sql stable security definer
set search_path = ''
as $$
  select private.hazard_public_json(h),
         (select v.vote from public.road_hazard_votes v where v.hazard_id = h.id and v.user_id = p_viewer)
    from public.road_hazards h
   where p_max_lat > p_min_lat and p_max_lng > p_min_lng
     and p_max_lat - p_min_lat <= 1.0 and p_max_lng - p_min_lng <= 1.6
     and private.hazard_is_active(h)
     and h.geog operator(extensions.&&)
         extensions.st_makeenvelope(p_min_lng, p_min_lat, p_max_lng, p_max_lat, 4326)::extensions.geography
   order by h.geog operator(extensions.<->)
            extensions.st_setsrid(extensions.st_makepoint((p_min_lng + p_max_lng) / 2, (p_min_lat + p_max_lat) / 2), 4326)::extensions.geography
   limit least(greatest(coalesce(p_limit, 200), 1), 200)
$$;

-- ─── Realtime fan-out to the hazard's area ───────────────────────────────────
-- realtime.send is transactional: nothing is delivered unless the change
-- commits.
create function private.on_road_hazard_change()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  topic text := private.hazard_topic(new.latitude, new.longitude);
begin
  if new.removed_at is not null then
    if tg_op = 'UPDATE' then
      if old.removed_at is null then
        perform realtime.send(jsonb_build_object('type', 'hazard_removed', 'id', new.id), 'hazard', topic, true);
      end if;
    end if;
    return null;
  end if;
  -- Only what the map shows: a "Not there" that removes nothing changes nothing on it
  if tg_op = 'UPDATE' then
    if old.support = new.support and old.expires_at = new.expires_at
       and old.removed_at is not distinct from new.removed_at then
      return null;
    end if;
  end if;
  if new.expires_at > now() then
    perform realtime.send(private.hazard_public_json(new) || jsonb_build_object('type', 'hazard'), 'hazard', topic, true);
  end if;
  return null;
end;
$$;
create trigger road_hazards_publish
  after insert or update of support, dismissals, expires_at, removed_at on public.road_hazards
  for each row execute function private.on_road_hazard_change();

-- A hazard never moves or changes kind: a new position is a new report
create trigger road_hazards_fixed before update of kind, latitude, longitude, created_at on public.road_hazards
  for each row when (old.kind is distinct from new.kind or old.latitude is distinct from new.latitude
                     or old.longitude is distinct from new.longitude or old.created_at is distinct from new.created_at)
  execute function private.reject_key_update('kind/latitude/longitude/created_at');
create trigger road_hazard_votes_keys_fixed before update of hazard_id, user_id on public.road_hazard_votes
  for each row when (old.hazard_id is distinct from new.hazard_id or old.user_id is distinct from new.user_id)
  execute function private.reject_key_update('hazard_id/user_id');

-- Area topics: any signed-in user may receive (the payloads are anonymous
-- and public within the app); with no insert policy, nobody can publish.
-- Only well-formed area topics: this never opens anyone's private inbox.
create policy driveos_hazard_area_receive on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and (select realtime.topic()) ~ '^hazards:-?[0-9]{1,3}:-?[0-9]{1,3}$'
  );

-- ─── Privileges and policies ─────────────────────────────────────────────────
revoke execute on function
  private.hazard_lifetime(text), private.hazard_max_lifetime(text), private.hazard_merge_radius_m(text),
  private.hazard_topic(double precision, double precision), private.hazard_is_active(public.road_hazards),
  private.hazard_public_json(public.road_hazards), private.hazard_extended_expiry(public.road_hazards),
  private.report_hazard(uuid, text, double precision, double precision), private.vote_hazard(uuid, uuid, text),
  private.hazards_in_view(uuid, double precision, double precision, double precision, double precision, integer),
  private.on_road_hazard_change()
from public, anon, authenticated;

revoke all on public.road_hazards, public.road_hazard_votes from anon, authenticated;

-- Reads only, for a future direct-access grant: active hazards (the table
-- holds no user), and your own reports and votes. No insert, update or
-- delete policy: every change goes through the API's functions above.
create policy road_hazards_select_active on public.road_hazards
  for select to authenticated
  using (expires_at > now() and removed_at is null);
create policy road_hazard_votes_select_own on public.road_hazard_votes
  for select to authenticated
  using (user_id = (select auth.uid()));
