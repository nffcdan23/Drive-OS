-- ============================================================================
-- 0010 · Achievements
-- The catalogue is seeded here; unlocks are written only by the server.
-- ============================================================================

create table public.achievements (
  id          text    primary key,
  title       text    not null,
  description text    not null,
  icon        text    not null,
  xp_reward   integer not null default 0,
  sort_order  integer not null default 0,
  is_hidden   boolean not null default false,

  constraint achievements_id_format check (id ~ '^[a-z0-9_]{2,40}$'),
  constraint achievements_xp_reward check (xp_reward >= 0)
);

alter table public.achievements enable row level security;

insert into public.achievements (id, title, description, icon, xp_reward, sort_order) values
  ('first_drive',   'First Drive',   'Completed your first tracked journey', 'flag-outline',        100, 1),
  ('century_run',   'Century Run',   'Drove 100 km in a single journey',     'speedometer-outline', 250, 2),
  ('early_bird',    'Early Bird',    'Started a drive before 7am',           'sunny-outline',       100, 3),
  ('road_warrior',  'Road Warrior',  'Drove 1,000 km in total',              'trophy-outline',      500, 4),
  ('convoy_leader', 'Convoy Leader', 'Led your first convoy',                'people-outline',      200, 5),
  ('mountain_road', 'Mountain Road', 'Drove above 600 m elevation',          'triangle-outline',    200, 6);

create table public.user_achievements (
  user_id           uuid        not null references public.profiles (id) on delete cascade,
  achievement_id    text        not null references public.achievements (id) on delete cascade,
  unlocked_at       timestamptz not null default now(),
  source_journey_id uuid        references public.journeys (id) on delete set null,

  primary key (user_id, achievement_id)
);

create index user_achievements_achievement_idx    on public.user_achievements (achievement_id);
create index user_achievements_source_journey_idx on public.user_achievements (source_journey_id) where source_journey_id is not null;

alter table public.user_achievements enable row level security;
