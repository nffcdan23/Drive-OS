-- ============================================================================
-- 0014 · Beauty Spot discovery
-- SECURITY INVOKER: when the app calls these directly, the caller's RLS
-- applies. The explicit visibility filter makes them safe for any caller:
-- with no signed-in user (e.g. the API's owner connection without request
-- claims) they return public spots only. To include a user's own and
-- friends-only spots, the API sets `request.jwt.claims` for the transaction.
-- ============================================================================

create function public.nearby_spots(
  p_lat      double precision,
  p_lng      double precision,
  p_radius_m double precision default 25000,
  p_limit    integer          default 50
)
returns table (
  id             uuid,
  owner_id       uuid,
  name           text,
  category       text,
  description    text,
  lat            double precision,
  lng            double precision,
  visibility     text,
  cover_photo_id uuid,
  distance_m     double precision
)
language sql
stable
security invoker
set search_path = ''
as $$
  with origin as (
    select extensions.st_setsrid(extensions.st_makepoint(p_lng, p_lat), 4326)::extensions.geography as g
  )
  select s.id, s.owner_id, s.name, s.category, s.description, s.lat, s.lng, s.visibility, s.cover_photo_id,
         extensions.st_distance(s.geog, o.g) as distance_m
  from public.saved_locations s, origin o
  where s.kind = 'beauty_spot'
    and s.status = 'active'
    and (s.visibility = 'public' or private.can_view(s.owner_id, s.visibility))
    and extensions.st_dwithin(s.geog, o.g, least(greatest(p_radius_m, 0), 200000))
  order by s.geog operator(extensions.<->) o.g
  limit least(greatest(p_limit, 1), 200)
$$;

create function public.spots_in_view(
  p_min_lat double precision,
  p_min_lng double precision,
  p_max_lat double precision,
  p_max_lng double precision,
  p_limit   integer default 200
)
returns table (
  id             uuid,
  owner_id       uuid,
  name           text,
  category       text,
  lat            double precision,
  lng            double precision,
  visibility     text,
  cover_photo_id uuid
)
language sql
stable
security invoker
set search_path = ''
as $$
  select s.id, s.owner_id, s.name, s.category, s.lat, s.lng, s.visibility, s.cover_photo_id
  from public.saved_locations s
  where s.kind = 'beauty_spot'
    and s.status = 'active'
    and (s.visibility = 'public' or private.can_view(s.owner_id, s.visibility))
    and s.geog operator(extensions.&&)
        extensions.st_makeenvelope(p_min_lng, p_min_lat, p_max_lng, p_max_lat, 4326)::extensions.geography
  limit least(greatest(p_limit, 1), 500)
$$;

-- Not callable by client roles until direct access is enabled.
revoke execute on function public.nearby_spots(double precision, double precision, double precision, integer) from public, anon, authenticated;
revoke execute on function public.spots_in_view(double precision, double precision, double precision, double precision, integer) from public, anon, authenticated;
