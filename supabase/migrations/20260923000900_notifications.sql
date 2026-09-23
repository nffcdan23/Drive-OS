-- ============================================================================
-- 0009 · Notifications, push devices, content reports
-- Notifications are created only by the server. Content reports are the
-- minimum moderation structure required for public user-generated content.
-- ============================================================================

-- ─── notifications ───────────────────────────────────────────────────────────
create table public.notifications (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        not null references public.profiles (id) on delete cascade,
  actor_user_id uuid        references public.profiles (id) on delete set null,
  type          text        not null,
  title         text        not null,
  body          text        not null default '',
  data          jsonb       not null default '{}'::jsonb,
  read_at       timestamptz,
  is_read       boolean     not null generated always as (read_at is not null) stored,
  created_at    timestamptz not null default now(),

  constraint notifications_type check (type in (
    'friend_request', 'friend_accepted', 'message', 'convoy_invite', 'convoy_updated',
    'convoy_cancelled', 'group_invite', 'group_request_result', 'group_news',
    'event_invite', 'event_reminder', 'achievement_unlocked', 'system')),
  constraint notifications_title_length check (char_length(title) between 1 and 120),
  constraint notifications_body_length  check (char_length(body) <= 500),
  constraint notifications_data_object  check (jsonb_typeof(data) = 'object')
);

create index notifications_user_created_idx on public.notifications (user_id, created_at desc);
create index notifications_user_unread_idx  on public.notifications (user_id) where read_at is null;
create index notifications_actor_idx        on public.notifications (actor_user_id) where actor_user_id is not null;

alter table public.notifications enable row level security;

-- ─── push_devices ────────────────────────────────────────────────────────────
create table public.push_devices (
  id              uuid        primary key default gen_random_uuid(),
  user_id         uuid        not null references public.profiles (id) on delete cascade,
  expo_push_token text        not null,
  platform        text        not null,
  app_version     text        not null default '',
  enabled         boolean     not null default true,
  last_seen_at    timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint push_devices_token_key unique (expo_push_token),
  constraint push_devices_platform  check (platform in ('ios', 'android', 'web'))
);

create index push_devices_user_idx on public.push_devices (user_id);

create trigger push_devices_set_updated_at
  before update on public.push_devices
  for each row execute function private.set_updated_at();

alter table public.push_devices enable row level security;

-- ─── content_reports ─────────────────────────────────────────────────────────
create table public.content_reports (
  id          uuid        primary key default gen_random_uuid(),
  -- Kept when the reporter deletes their account.
  reporter_id uuid        references public.profiles (id) on delete set null,
  target_type text        not null,
  target_id   uuid        not null,
  reason      text        not null,
  details     text        not null default '',
  status      text        not null default 'open',
  created_at  timestamptz not null default now(),
  resolved_at timestamptz,

  constraint content_reports_target_type check (target_type in (
    'location', 'photo', 'profile', 'group', 'event', 'convoy', 'journey')),
  constraint content_reports_reason      check (reason in (
    'spam', 'inappropriate', 'harassment', 'dangerous', 'privacy', 'other')),
  constraint content_reports_details     check (char_length(details) <= 2000),
  constraint content_reports_status      check (status in ('open', 'reviewing', 'actioned', 'dismissed'))
);

-- One open report per reporter per target.
create unique index content_reports_one_open_per_target
  on public.content_reports (reporter_id, target_type, target_id) where status = 'open';
create index content_reports_status_idx on public.content_reports (status, created_at);
create index content_reports_target_idx on public.content_reports (target_type, target_id);

alter table public.content_reports enable row level security;
