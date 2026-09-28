-- ============================================================================
-- 0005 · Journeys, categories, route points
-- Raw GPS points are owner-only and keyed (journey_id, recorded_at) so that a
-- re-sent batch cannot create duplicates. The full route summary is kept in
-- the owner-only journey_routes table; the shareable journeys row only carries
-- a start/end-trimmed polyline.
-- ============================================================================

-- ─── journey_categories ──────────────────────────────────────────────────────
create table public.journey_categories (
  id         uuid        primary key default gen_random_uuid(),
  -- NULL owner = shared default category visible to everyone.
  owner_id   uuid        references public.profiles (id) on delete cascade,
  is_default boolean     not null generated always as (owner_id is null) stored,
  name       text        not null,
  icon       text        not null,
  colour     text        not null,
  sort_order integer     not null default 0,
  created_at timestamptz not null default now(),

  constraint journey_categories_name_length check (char_length(name) between 1 and 40),
  constraint journey_categories_icon_length check (char_length(icon) between 1 and 40),
  constraint journey_categories_colour      check (colour ~ '^#[0-9A-Fa-f]{6}$')
);

-- One name per owner (case-insensitive); shared defaults share one namespace.
create unique index journey_categories_owner_name_key
  on public.journey_categories (coalesce(owner_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

alter table public.journey_categories enable row level security;

insert into public.journey_categories (owner_id, name, icon, colour, sort_order) values
  (null, 'Daily Commute', 'car',      '#4B9EFF', 0),
  (null, 'Road Trip',     'map',      '#FF6B6B', 1),
  (null, 'Track Day',     'flag',     '#FFD700', 2),
  (null, 'Weekend Drive', 'sun',      '#4ECDC4', 3),
  (null, 'Night Cruise',  'moon',     '#9B59B6', 4),
  (null, 'Mountain Run',  'triangle', '#E67E22', 5),
  (null, 'Coastal Drive', 'anchor',   '#3498DB', 6),
  (null, 'Cross Country', 'compass',  '#2ECC71', 7);

-- ─── journeys ────────────────────────────────────────────────────────────────
create table public.journeys (
  id                    uuid             primary key default gen_random_uuid(),
  owner_id              uuid             not null references public.profiles (id) on delete cascade,
  client_ref            text,
  vehicle_id            uuid,
  category_id           uuid             references public.journey_categories (id) on delete set null,
  convoy_id             uuid             references public.convoys (id) on delete set null,
  name                  text             not null default 'Unnamed Journey',
  notes                 text             not null default '',
  status                text             not null default 'active',
  visibility            text             not null default 'private',
  journey_type          text             not null default 'personal',
  started_at            timestamptz      not null,
  ended_at              timestamptz,
  -- IANA zone of the device, so the local date/time can be shown correctly.
  timezone              text             not null default 'Europe/London',
  duration_seconds      integer          not null default 0,
  distance_km           double precision not null default 0,
  avg_speed_kmh         double precision not null default 0,
  top_speed_kmh         double precision not null default 0,
  xp_earned             integer          not null default 0,
  vehicle_snapshot      jsonb,
  -- Start/end-trimmed route for anyone the journey is shared with. The full
  -- route (which reveals where the owner starts and ends) is owner-only, in
  -- journey_routes.
  public_route_polyline text,
  created_at            timestamptz      not null default now(),
  updated_at            timestamptz      not null default now(),

  constraint journeys_id_owner_key         unique (id, owner_id),
  constraint journeys_owner_client_ref_key unique (owner_id, client_ref),
  -- Owner-safe vehicle link; deleting the vehicle clears only vehicle_id.
  constraint journeys_vehicle_fk
    foreign key (vehicle_id, owner_id) references public.vehicles (id, owner_id) on delete set null (vehicle_id),
  constraint journeys_name_length       check (char_length(name) between 1 and 120),
  constraint journeys_notes_length      check (char_length(notes) <= 5000),
  constraint journeys_status            check (status in ('active', 'completed', 'abandoned')),
  constraint journeys_visibility        check (visibility in ('private', 'friends', 'public')),
  constraint journeys_journey_type      check (journey_type in ('personal', 'convoy')),
  constraint journeys_completed_has_end check (status <> 'completed' or ended_at is not null),
  constraint journeys_times             check (ended_at is null or ended_at >= started_at),
  constraint journeys_stats_nonnegative check (
    duration_seconds >= 0 and distance_km >= 0 and avg_speed_kmh >= 0 and top_speed_kmh >= 0 and
    xp_earned >= 0),
  constraint journeys_vehicle_snapshot  check (vehicle_snapshot is null or jsonb_typeof(vehicle_snapshot) = 'object')
);

create index journeys_owner_completed_idx on public.journeys (owner_id, started_at desc) where status = 'completed';
create index journeys_owner_active_idx    on public.journeys (owner_id) where status = 'active';
create index journeys_vehicle_idx         on public.journeys (vehicle_id) where vehicle_id is not null;
create index journeys_category_idx        on public.journeys (category_id) where category_id is not null;
create index journeys_convoy_idx          on public.journeys (convoy_id) where convoy_id is not null;

create trigger journeys_set_updated_at
  before update on public.journeys
  for each row execute function private.set_updated_at();

alter table public.journeys enable row level security;

-- ─── journey_route_points ────────────────────────────────────────────────────
create table public.journey_route_points (
  journey_id  uuid             not null references public.journeys (id) on delete cascade,
  recorded_at timestamptz      not null,
  latitude    double precision not null,
  longitude   double precision not null,
  speed_kmh   real             not null default 0,
  heading_deg real,
  accuracy_m  real,
  altitude_m  real,

  -- Doubles as the lookup index for a journey's route, in time order.
  primary key (journey_id, recorded_at),
  constraint journey_route_points_lat      check (latitude between -90 and 90),
  constraint journey_route_points_lng      check (longitude between -180 and 180),
  constraint journey_route_points_speed    check (speed_kmh >= 0),
  constraint journey_route_points_heading  check (heading_deg is null or (heading_deg >= 0 and heading_deg < 360)),
  constraint journey_route_points_accuracy check (accuracy_m is null or accuracy_m >= 0)
);

alter table public.journey_route_points enable row level security;

-- ─── journey_routes (owner only) ─────────────────────────────────────────────
-- Full route summary, written by the server when a journey is completed.
-- Separate from journeys because the journeys row can be shared with friends
-- or the public, and these values reveal where the owner starts and ends.
create table public.journey_routes (
  journey_id     uuid             primary key,
  owner_id       uuid             not null,
  route_polyline text,
  point_count    integer          not null default 0,
  start_lat      double precision,
  start_lng      double precision,
  end_lat        double precision,
  end_lng        double precision,
  bbox_min_lat   double precision,
  bbox_min_lng   double precision,
  bbox_max_lat   double precision,
  bbox_max_lng   double precision,
  created_at     timestamptz      not null default now(),
  updated_at     timestamptz      not null default now(),

  constraint journey_routes_journey_fk
    foreign key (journey_id, owner_id) references public.journeys (id, owner_id) on delete cascade,
  constraint journey_routes_point_count check (point_count >= 0)
);

create index journey_routes_owner_idx on public.journey_routes (owner_id);

create trigger journey_routes_set_updated_at
  before update on public.journey_routes
  for each row execute function private.set_updated_at();

alter table public.journey_routes enable row level security;
