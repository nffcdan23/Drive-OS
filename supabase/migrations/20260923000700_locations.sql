-- ============================================================================
-- 0007 · Saved locations and Beauty Spots
-- One table for Home, Work, favourite roads, meeting points, car parks,
-- custom POIs and Beauty Spots. Coordinates are plain lat/lng; `geog` is a
-- generated PostGIS column used only for radius / map-viewport queries.
-- ============================================================================

create table public.saved_locations (
  id                uuid             primary key default gen_random_uuid(),
  owner_id          uuid             not null references public.profiles (id) on delete cascade,
  client_ref        text,
  kind              text             not null,
  -- Beauty Spot sub-category; NULL for every other kind.
  category          text,
  name              text             not null,
  description       text             not null default '',
  address           text             not null default '',
  lat               double precision not null,
  lng               double precision not null,
  geog              extensions.geography(Point, 4326) not null
                    generated always as (
                      extensions.st_setsrid(extensions.st_makepoint(lng, lat), 4326)::extensions.geography
                    ) stored,
  -- Optional line for kinds that are roads rather than points.
  route_polyline    text,
  visibility        text             not null default 'private',
  -- Moderation hook: only 'active' rows are visible to anyone but the owner.
  status            text             not null default 'active',
  cover_photo_id    uuid,            -- FK to photos added in 0008
  source_journey_id uuid             references public.journeys (id) on delete set null,
  created_at        timestamptz      not null default now(),
  updated_at        timestamptz      not null default now(),

  constraint saved_locations_owner_client_ref_key unique (owner_id, client_ref),
  constraint saved_locations_kind check (kind in (
    'home', 'work', 'favourite_road', 'meeting_point', 'car_park', 'poi', 'beauty_spot')),
  constraint saved_locations_category check (
    category is null or (kind = 'beauty_spot' and category in (
      'viewpoint', 'coastal', 'mountain_pass', 'lake', 'forest', 'scenic_road',
      'landmark', 'photo_spot', 'other'))),
  constraint saved_locations_name_length        check (char_length(name) between 1 and 100),
  constraint saved_locations_description_length check (char_length(description) <= 2000),
  constraint saved_locations_address_length     check (char_length(address) <= 300),
  constraint saved_locations_lat                check (lat between -90 and 90),
  constraint saved_locations_lng                check (lng between -180 and 180),
  constraint saved_locations_visibility         check (visibility in ('private', 'friends', 'public')),
  constraint saved_locations_status             check (status in ('active', 'hidden', 'removed')),
  -- Home and Work can never be shared.
  constraint saved_locations_home_work_private  check (kind not in ('home', 'work') or visibility = 'private'),
  -- Only Beauty Spots and meeting points can be public.
  constraint saved_locations_public_kinds       check (visibility <> 'public' or kind in ('beauty_spot', 'meeting_point'))
);

-- One Home and one Work per user.
create unique index saved_locations_one_home_work on public.saved_locations (owner_id, kind) where kind in ('home', 'work');
create index saved_locations_geog_idx          on public.saved_locations using gist (geog);
create index saved_locations_source_journey_idx on public.saved_locations (source_journey_id) where source_journey_id is not null;

create trigger saved_locations_set_updated_at
  before update on public.saved_locations
  for each row execute function private.set_updated_at();

alter table public.saved_locations enable row level security;
