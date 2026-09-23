-- ============================================================================
-- 0006 · Friendships and friend requests
-- Friendships are stored as two rows (A→B and B→A), written together by the
-- server when a request is accepted. Requests target a user id, never a code.
-- ============================================================================

-- ─── friendships ─────────────────────────────────────────────────────────────
create table public.friendships (
  user_id    uuid        not null references public.profiles (id) on delete cascade,
  friend_id  uuid        not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),

  primary key (user_id, friend_id),
  constraint friendships_not_self check (user_id <> friend_id)
);

create index friendships_friend_idx on public.friendships (friend_id);

alter table public.friendships enable row level security;

-- ─── friend_requests ─────────────────────────────────────────────────────────
create table public.friend_requests (
  id           uuid        primary key default gen_random_uuid(),
  from_user_id uuid        not null references public.profiles (id) on delete cascade,
  to_user_id   uuid        not null references public.profiles (id) on delete cascade,
  status       text        not null default 'pending',
  created_at   timestamptz not null default now(),
  responded_at timestamptz,

  constraint friend_requests_not_self        check (from_user_id <> to_user_id),
  constraint friend_requests_status          check (status in ('pending', 'accepted', 'declined', 'cancelled')),
  constraint friend_requests_responded_state check ((status = 'pending') = (responded_at is null))
);

-- At most one pending request per pair of users, whichever direction.
create unique index friend_requests_one_pending_per_pair
  on public.friend_requests (least(from_user_id, to_user_id), greatest(from_user_id, to_user_id))
  where status = 'pending';
create index friend_requests_to_status_idx   on public.friend_requests (to_user_id, status);
create index friend_requests_from_status_idx on public.friend_requests (from_user_id, status);

alter table public.friend_requests enable row level security;
