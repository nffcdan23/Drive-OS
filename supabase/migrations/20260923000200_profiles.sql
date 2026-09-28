-- ============================================================================
-- 0002 · Profiles, settings, blocks
-- One `profiles` row per Supabase Auth user, keyed by auth.users.id and
-- created by a trigger at sign-up. Private settings live in `user_settings`
-- so other users' policies can consult them without ever reading them.
-- ============================================================================

-- XP curve: 1,000 XP per level. Change here plus a migration that rewrites
-- the generated `profiles.level` column if the curve ever changes.
create function private.level_for_xp(p_xp integer)
returns integer
language sql
immutable
set search_path = ''
as $$
  select floor(greatest(coalesce(p_xp, 0), 0) / 1000.0)::integer + 1
$$;

create function private.xp_for_level(p_level integer)
returns integer
language sql
immutable
set search_path = ''
as $$
  select (greatest(coalesce(p_level, 1), 1) - 1) * 1000
$$;

-- Friend codes are shareable (not secret): 8 characters with no look-alike
-- characters, retried until unused.
create function private.generate_friend_code()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  code text;
begin
  loop
    code := '';
    for i in 1..8 loop
      code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::integer, 1);
    end loop;
    exit when not exists (select 1 from public.profiles p where p.friend_code = code);
  end loop;
  return code;
end;
$$;

-- ─── profiles ────────────────────────────────────────────────────────────────
create table public.profiles (
  id                uuid        primary key references auth.users (id) on delete cascade,
  username          text,
  display_name      text        not null default 'Driver',
  bio               text        not null default '',
  avatar_path       text,
  friend_code       text        not null default private.generate_friend_code(),
  -- Server-maintained stats. `level` is derived from `xp` and can never drift.
  xp                integer     not null default 0,
  level             integer     not null generated always as (private.level_for_xp(xp)) stored,
  total_distance_km double precision not null default 0,
  total_journeys    integer     not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint profiles_friend_code_key      unique (friend_code),
  constraint profiles_friend_code_format   check (friend_code ~ '^[A-Z0-9]{8}$'),
  constraint profiles_username_format      check (username is null or username ~ '^[A-Za-z0-9_.]{3,30}$'),
  constraint profiles_display_name_length  check (char_length(display_name) between 1 and 50),
  constraint profiles_bio_length           check (char_length(bio) <= 500),
  constraint profiles_xp_nonnegative       check (xp >= 0),
  constraint profiles_totals_nonnegative   check (total_distance_km >= 0 and total_journeys >= 0)
);

-- Usernames are unique regardless of case.
create unique index profiles_username_lower_key on public.profiles (lower(username)) where username is not null;

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function private.set_updated_at();

alter table public.profiles enable row level security;

-- ─── user_settings (owner-only) ──────────────────────────────────────────────
create table public.user_settings (
  user_id                        uuid        primary key references public.profiles (id) on delete cascade,
  unit_system                    text        not null default 'auto',
  profile_visibility             text        not null default 'public',
  default_journey_visibility     text        not null default 'private',
  default_location_visibility    text        not null default 'private',
  allow_friend_requests          text        not null default 'everyone',
  share_live_location_in_convoys boolean     not null default true,
  notification_prefs             jsonb       not null default '{}'::jsonb,
  created_at                     timestamptz not null default now(),
  updated_at                     timestamptz not null default now(),

  constraint user_settings_unit_system            check (unit_system in ('auto', 'metric', 'imperial')),
  constraint user_settings_profile_visibility     check (profile_visibility in ('private', 'friends', 'public')),
  constraint user_settings_journey_visibility     check (default_journey_visibility in ('private', 'friends', 'public')),
  constraint user_settings_location_visibility    check (default_location_visibility in ('private', 'friends', 'public')),
  constraint user_settings_allow_friend_requests  check (allow_friend_requests in ('everyone', 'nobody')),
  constraint user_settings_notification_prefs     check (jsonb_typeof(notification_prefs) = 'object')
);

create trigger user_settings_set_updated_at
  before update on public.user_settings
  for each row execute function private.set_updated_at();

alter table public.user_settings enable row level security;

-- ─── user_blocks ─────────────────────────────────────────────────────────────
create table public.user_blocks (
  blocker_id uuid        not null references public.profiles (id) on delete cascade,
  blocked_id uuid        not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),

  primary key (blocker_id, blocked_id),
  constraint user_blocks_not_self check (blocker_id <> blocked_id)
);

create index user_blocks_blocked_id_idx on public.user_blocks (blocked_id);

alter table public.user_blocks enable row level security;

-- ─── Sign-up trigger ─────────────────────────────────────────────────────────
-- Runs inside the Auth sign-up transaction, so it must stay minimal: a
-- failure here blocks the sign-up.
create function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    left(coalesce(
      nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''),
      nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
      nullif(btrim(new.raw_user_meta_data ->> 'name'), ''),
      'Driver'
    ), 50)
  );
  insert into public.user_settings (user_id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();
