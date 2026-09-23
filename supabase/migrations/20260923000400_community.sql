-- ============================================================================
-- 0004 · Groups, convoys, events
-- Visibility and membership rules live here as constraints; the rules that
-- need row locks (capacity, max participants) are enforced by the API inside
-- a transaction.
-- ============================================================================

-- ─── groups ──────────────────────────────────────────────────────────────────
create table public.groups (
  id                uuid        primary key default gen_random_uuid(),
  owner_id          uuid        not null references public.profiles (id) on delete cascade,
  name              text        not null,
  description       text        not null default '',
  logo_path         text,
  -- true: listed and visible to every signed-in user.
  -- false: visible only to members (active, pending or invited).
  is_public         boolean     not null default true,
  membership_method text        not null default 'open',
  join_code         text,
  primary_location  text        not null default '',
  vehicle_interests text        not null default '',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint groups_join_code_key       unique (join_code),
  constraint groups_name_length         check (char_length(name) between 1 and 80),
  constraint groups_description_length  check (char_length(description) <= 2000),
  constraint groups_membership_method   check (membership_method in ('open', 'request', 'invite', 'code')),
  constraint groups_code_requires_code  check (membership_method <> 'code' or join_code is not null)
);

create index groups_owner_idx on public.groups (owner_id);

create trigger groups_set_updated_at
  before update on public.groups
  for each row execute function private.set_updated_at();

alter table public.groups enable row level security;

-- ─── group_members ───────────────────────────────────────────────────────────
create table public.group_members (
  group_id   uuid        not null references public.groups (id) on delete cascade,
  user_id    uuid        not null references public.profiles (id) on delete cascade,
  role       text        not null default 'member',
  status     text        not null default 'active',
  invited_by uuid        references public.profiles (id) on delete set null,
  joined_at  timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (group_id, user_id),
  constraint group_members_role          check (role in ('owner', 'admin', 'member')),
  constraint group_members_status        check (status in ('active', 'pending', 'invited')),
  constraint group_members_owner_active  check (role <> 'owner' or status = 'active')
);

create unique index group_members_one_owner on public.group_members (group_id) where role = 'owner';
create index group_members_user_idx on public.group_members (user_id);

create trigger group_members_set_updated_at
  before update on public.group_members
  for each row execute function private.set_updated_at();

alter table public.group_members enable row level security;

-- ─── convoys ─────────────────────────────────────────────────────────────────
create table public.convoys (
  id               uuid             primary key default gen_random_uuid(),
  owner_id         uuid             not null references public.profiles (id) on delete cascade,
  group_id         uuid             references public.groups (id) on delete set null,
  name             text             not null,
  description      text             not null default '',
  destination_name text             not null default '',
  destination_lat  double precision,
  destination_lng  double precision,
  visibility       text             not null default 'public',
  join_code        text,
  starts_at        timestamptz      not null,
  status           text             not null default 'forming',
  started_at       timestamptz,
  ended_at         timestamptz,
  max_participants integer,
  created_at       timestamptz      not null default now(),
  updated_at       timestamptz      not null default now(),

  constraint convoys_join_code_key       unique (join_code),
  constraint convoys_name_length         check (char_length(name) between 1 and 80),
  constraint convoys_description_length  check (char_length(description) <= 2000),
  constraint convoys_visibility          check (visibility in ('public', 'friends', 'private')),
  constraint convoys_status              check (status in ('forming', 'active', 'completed', 'cancelled')),
  constraint convoys_destination_pair    check ((destination_lat is null) = (destination_lng is null)),
  constraint convoys_destination_range   check (
    destination_lat is null or (destination_lat between -90 and 90 and destination_lng between -180 and 180)),
  constraint convoys_max_participants    check (max_participants is null or max_participants >= 2),
  constraint convoys_times               check (ended_at is null or started_at is null or ended_at >= started_at)
);

create index convoys_owner_idx     on public.convoys (owner_id);
create index convoys_group_idx     on public.convoys (group_id) where group_id is not null;
create index convoys_starts_at_idx on public.convoys (starts_at);

create trigger convoys_set_updated_at
  before update on public.convoys
  for each row execute function private.set_updated_at();

alter table public.convoys enable row level security;

-- ─── convoy_participants ─────────────────────────────────────────────────────
create table public.convoy_participants (
  convoy_id uuid        not null references public.convoys (id) on delete cascade,
  user_id   uuid        not null references public.profiles (id) on delete cascade,
  role      text        not null default 'member',
  joined_at timestamptz not null default now(),

  primary key (convoy_id, user_id),
  constraint convoy_participants_role check (role in ('leader', 'member'))
);

create unique index convoy_participants_one_leader on public.convoy_participants (convoy_id) where role = 'leader';
create index convoy_participants_user_idx on public.convoy_participants (user_id);

alter table public.convoy_participants enable row level security;

-- ─── events ──────────────────────────────────────────────────────────────────
create table public.events (
  id               uuid             primary key default gen_random_uuid(),
  organiser_id     uuid             not null references public.profiles (id) on delete cascade,
  group_id         uuid             references public.groups (id) on delete set null,
  name             text             not null,
  description      text             not null default '',
  cover_path       text,
  location_name    text             not null default '',
  lat              double precision,
  lng              double precision,
  geog             extensions.geography(Point, 4326)
                   generated always as (
                     extensions.st_setsrid(extensions.st_makepoint(lng, lat), 4326)::extensions.geography
                   ) stored,
  starts_at        timestamptz      not null,
  ends_at          timestamptz,
  timezone         text             not null default 'Europe/London',
  event_type       text             not null default 'other',
  visibility       text             not null default 'public',
  capacity         integer,
  entry_cost       text             not null default 'Free',
  vehicle_category text             not null default 'All',
  created_at       timestamptz      not null default now(),
  updated_at       timestamptz      not null default now(),

  constraint events_name_length         check (char_length(name) between 1 and 120),
  constraint events_description_length  check (char_length(description) <= 5000),
  constraint events_coordinates_pair    check ((lat is null) = (lng is null)),
  constraint events_coordinates_range   check (lat is null or (lat between -90 and 90 and lng between -180 and 180)),
  constraint events_times               check (ends_at is null or ends_at >= starts_at),
  constraint events_event_type          check (event_type in (
    'static_car_meet', 'scenic_drive', 'convoy', 'road_trip', 'show', 'track_day',
    'closed_course', 'charity', 'photography', 'owner_club', 'other')),
  constraint events_visibility          check (visibility in ('public', 'group', 'private')),
  constraint events_group_visibility    check (visibility <> 'group' or group_id is not null),
  constraint events_capacity            check (capacity is null or capacity > 0)
);

create index events_organiser_idx on public.events (organiser_id);
create index events_group_idx     on public.events (group_id) where group_id is not null;
create index events_starts_at_idx on public.events (starts_at);
create index events_geog_idx      on public.events using gist (geog) where geog is not null;

create trigger events_set_updated_at
  before update on public.events
  for each row execute function private.set_updated_at();

alter table public.events enable row level security;

-- ─── event_rsvps ─────────────────────────────────────────────────────────────
create table public.event_rsvps (
  event_id   uuid        not null references public.events (id) on delete cascade,
  user_id    uuid        not null references public.profiles (id) on delete cascade,
  status     text        not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (event_id, user_id),
  constraint event_rsvps_status check (status in ('going', 'interested', 'declined', 'invited'))
);

create index event_rsvps_user_idx         on public.event_rsvps (user_id);
create index event_rsvps_event_status_idx on public.event_rsvps (event_id, status);

create trigger event_rsvps_set_updated_at
  before update on public.event_rsvps
  for each row execute function private.set_updated_at();

alter table public.event_rsvps enable row level security;
