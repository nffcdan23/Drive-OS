-- ============================================================================
-- 0021 · Road hazards: the reporter's direction of travel (optional)
--
-- Additive. One nullable column, road_hazards.travel_heading_deg: which way
-- the reporting driver was travelling, as a 10° bucket (0, 10, … 350; 0 is
-- north). Set only when the app judged the GPS course reliable (moving
-- briskly, a valid course, a fresh and accurate fix); otherwise null, and a
-- hazard without one behaves exactly as before.
--
-- Why 10°: a phone's GPS course at road speeds wanders by about ±10–20°, and
-- the app compares it with a ±60° tolerance, so 5° of rounding loses nothing
-- useful, while it stores no more than which way the road was being driven.
-- No speed, route, journey or earlier position is stored with it; the
-- reporter stays invisible to everyone else (0020).
--
-- Uses:
--  * merging: a report whose direction is clearly opposite (over 120° apart)
--    to an active hazard's is a separate incident (the other carriageway of
--    a motorway, 25 m away), not a confirmation of it. Without a direction on
--    either side, the spatial rule of 0020 applies unchanged; near-same or
--    crossing directions still merge, so GPS noise never splits one report;
--  * the app's warnings: a hazard is matched only to the route going its way
--    (lib/hazards/warnings.ts);
--  * a hazard reported without a direction takes the first reliable one a
--    later merged report brings; once set, a hazard's direction never changes.
--
-- The 0020 four-argument private.report_hazard stays (now reporting with no
-- direction), so the API version deployed before this one keeps working.
-- ============================================================================

alter table public.road_hazards
  add column travel_heading_deg smallint,
  add constraint road_hazards_travel_heading check (
    travel_heading_deg is null or (travel_heading_deg between 0 and 359 and travel_heading_deg % 10 = 0));

comment on column public.road_hazards.travel_heading_deg is
  'The reporter''s direction of travel, 10° buckets (0–350, 0 = north), when the app judged it reliable; null otherwise. Not user tracking: no speed, route or reporter is kept with it.';

-- A direction, once known, is never changed (it can only be filled in)
create function private.reject_heading_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'a hazard''s direction of travel cannot be changed once set' using errcode = '42501';
end;
$$;
create trigger road_hazards_heading_fixed before update of travel_heading_deg on public.road_hazards
  for each row when (old.travel_heading_deg is not null and old.travel_heading_deg is distinct from new.travel_heading_deg)
  execute function private.reject_heading_change();

-- A course in degrees as a 10° bucket (null for none or nonsense)
create function private.hazard_heading_bucket(p_heading double precision)
returns smallint
language sql immutable
set search_path = ''
as $$
  select case
    when p_heading is null or p_heading = 'NaN'::float8 or p_heading < 0 or p_heading >= 360 then null
    else ((round(p_heading / 10) * 10)::int % 360)::smallint
  end
$$;

-- Two known directions more than 120° apart: clearly opposite ways
create function private.hazard_headings_opposite(a smallint, b smallint)
returns boolean
language sql immutable
set search_path = ''
as $$
  select a is not null and b is not null
     and least(abs(a - b) % 360, 360 - abs(a - b) % 360) > 120
$$;

-- The map's view of a hazard gains its direction (when known): still no user
create or replace function private.hazard_public_json(h public.road_hazards)
returns jsonb
language sql stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', h.id,
    'kind', h.kind,
    'latitude', h.latitude,
    'longitude', h.longitude,
    'travelHeadingDeg', h.travel_heading_deg,
    'reportedAt', to_char(h.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'lastConfirmedAt', to_char(h.last_confirmed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expiresAt', to_char(h.expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'expiresInMs', greatest(0, floor(extract(epoch from (h.expires_at - clock_timestamp())) * 1000))::bigint,
    'confirmations', h.support - 1)
$$;

-- Report a hazard, with the reporter's direction of travel when known
-- (degrees; bucketed here). Outcomes as in 0020. A report clearly opposite
-- in direction to a nearby active hazard of the same kind is not merged
-- into it.
create function private.report_hazard(
  p_user uuid, p_kind text, p_lat double precision, p_lng double precision, p_heading double precision)
returns table (hazard_id uuid, outcome text)
language plpgsql security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  here     extensions.geography;
  heading  smallint := private.hazard_heading_bucket(p_heading);
  nearest  uuid;
  existing public.road_hazards;
  mine     text;
  created  uuid;
begin
  if p_user is null or private.hazard_lifetime(p_kind) is null
     or p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    raise exception 'invalid hazard report' using errcode = '22023';
  end if;
  -- One report at a time per person, then per kind and area (as in 0020)
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
  -- The nearest active one going the same way (or of unknown direction)
  select h.id into nearest
    from public.road_hazards h
   where h.kind = p_kind and h.expires_at > now() and h.removed_at is null
     and extensions.st_dwithin(h.geog, here, private.hazard_merge_radius_m(p_kind))
     and not private.hazard_headings_opposite(h.travel_heading_deg, heading)
   order by h.geog operator(extensions.<->) here
   limit 1;
  if nearest is not null then
    select * into existing from public.road_hazards where id = nearest for update;
  end if;

  if nearest is not null and private.hazard_is_active(existing)
     and not private.hazard_headings_opposite(existing.travel_heading_deg, heading) then
    select v.vote into mine from public.road_hazard_votes v where v.hazard_id = existing.id and v.user_id = p_user;
    if mine in ('reported', 'still_there') then
      return query select existing.id, 'already_reported'::text;
      return;
    end if;
    if mine = 'not_there' then
      update public.road_hazard_votes set vote = 'reported', created_at = now()
       where road_hazard_votes.hazard_id = existing.id and user_id = p_user;
      update public.road_hazards h
         set support = h.support + 1, dismissals = h.dismissals - 1, last_confirmed_at = now(),
             expires_at = private.hazard_extended_expiry(h),
             travel_heading_deg = coalesce(h.travel_heading_deg, heading)
       where h.id = existing.id;
    else
      insert into public.road_hazard_votes (hazard_id, user_id, vote) values (existing.id, p_user, 'reported');
      update public.road_hazards h
         set support = h.support + 1, last_confirmed_at = now(), expires_at = private.hazard_extended_expiry(h),
             travel_heading_deg = coalesce(h.travel_heading_deg, heading)
       where h.id = existing.id;
    end if;
    return query select existing.id, 'merged'::text;
    return;
  end if;

  insert into public.road_hazards (kind, latitude, longitude, expires_at, travel_heading_deg)
  values (p_kind, round(p_lat::numeric, 5)::float8, round(p_lng::numeric, 5)::float8,
          now() + private.hazard_lifetime(p_kind), heading)
  returning id into created;
  insert into public.road_hazard_votes (hazard_id, user_id, vote) values (created, p_user, 'reported');
  return query select created, 'created'::text;
end;
$$;

-- 0020's signature, as the previously deployed API calls it: no direction
create or replace function private.report_hazard(p_user uuid, p_kind text, p_lat double precision, p_lng double precision)
returns table (hazard_id uuid, outcome text)
language plpgsql security definer
set search_path = ''
as $$
begin
  return query select r.hazard_id, r.outcome from private.report_hazard(p_user, p_kind, p_lat, p_lng, null::double precision) r;
end;
$$;

revoke execute on function
  private.reject_heading_change(), private.hazard_heading_bucket(double precision),
  private.hazard_headings_opposite(smallint, smallint),
  private.report_hazard(uuid, text, double precision, double precision, double precision),
  private.report_hazard(uuid, text, double precision, double precision),
  private.hazard_public_json(public.road_hazards)
from public, anon, authenticated;
