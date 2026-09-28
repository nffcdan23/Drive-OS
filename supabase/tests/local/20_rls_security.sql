-- ============================================================================
-- RLS and security tests.
--
-- Runs in its own throwaway database locally (stub + all migrations, no other
-- data), and against the real staging project from the staging workflow
-- INSIDE A TRANSACTION THAT IS ALWAYS ROLLED BACK: the fixture rows and the
-- worst-case GRANTs below are never committed, so they are never visible to
-- the Data API. Never run it any other way against a hosted project.
-- Every check executes as a real `authenticated` or `anon` session with the
-- JWT claims Supabase would set, so policies, helper functions, column
-- guards, constraints and privileges are all exercised together.
--
-- Part 1 proves the current state: client roles hold no privileges at all.
-- Part 2 then GRANTS FULL table privileges to anon and authenticated — the
-- worst case for any future direct-access migration — and proves that RLS,
-- the client write guards and the constraints alone still enforce every rule.
--
-- Actors
--   alice  owns most of the fixture data
--   bob    alice's friend; admin of her public group; member of her private one
--   carol  a stranger to alice
--   dave   blocked by alice
--   anon   no signed-in user
-- ============================================================================
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null
set client_min_messages = notice;

-- ─── Test helpers ────────────────────────────────────────────────────────────
-- Each helper switches to the actor's role and JWT claims for exactly one
-- statement, then switches back before asserting.

create function pg_temp.uid(p_who text)
returns uuid language sql immutable as $$
  select case p_who
    when 'alice' then 'a0000000-0000-0000-0000-000000000000'
    when 'bob'   then 'b0000000-0000-0000-0000-000000000000'
    when 'carol' then 'c0000000-0000-0000-0000-000000000000'
    when 'dave'  then 'd0000000-0000-0000-0000-000000000000'
  end::uuid
$$;

create function pg_temp.become(p_who text)
returns void language plpgsql as $$
begin
  if p_who = 'anon' then
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    perform set_config('role', 'anon', true);
  else
    perform set_config('request.jwt.claims',
      json_build_object('sub', pg_temp.uid(p_who), 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
  end if;
end;
$$;

-- Asserts the number of rows a query returns for an actor.
create function pg_temp.check_rows(p_who text, p_sql text, p_expected bigint, p_label text)
returns void language plpgsql as $$
declare
  n bigint;
begin
  perform pg_temp.become(p_who);
  begin
    execute format('select count(*) from (%s) q', p_sql) into n;
  exception when others then
    reset role; perform set_config('request.jwt.claims', '', true);
    raise exception 'FAIL: % — query raised % (%)', p_label, sqlstate, sqlerrm;
  end;
  reset role; perform set_config('request.jwt.claims', '', true);
  if n is distinct from p_expected then
    raise exception 'FAIL: % — expected % rows, got %', p_label, p_expected, n;
  end if;
  raise notice 'ok   % [%]', p_label, n;
end;
$$;

-- Asserts the rows returned for an actor, as a sorted text list.
create function pg_temp.check_list(p_who text, p_sql text, p_expected text[], p_label text)
returns void language plpgsql as $$
declare
  v text[];
begin
  perform pg_temp.become(p_who);
  begin
    execute format('select coalesce(array_agg(x::text order by x::text), ''{}'') from (%s) q(x)', p_sql) into v;
  exception when others then
    reset role; perform set_config('request.jwt.claims', '', true);
    raise exception 'FAIL: % — query raised % (%)', p_label, sqlstate, sqlerrm;
  end;
  reset role; perform set_config('request.jwt.claims', '', true);
  if v is distinct from (select coalesce(array_agg(e order by e), '{}') from unnest(p_expected) e) then
    raise exception 'FAIL: % — expected %, got %', p_label, p_expected, v;
  end if;
  raise notice 'ok   % %', p_label, v;
end;
$$;

-- Asserts how many rows a write affects for an actor (RLS filters silently).
create function pg_temp.check_affects(p_who text, p_sql text, p_expected bigint, p_label text)
returns void language plpgsql as $$
declare
  n bigint;
begin
  perform pg_temp.become(p_who);
  begin
    execute p_sql;
    get diagnostics n = row_count;
  exception when others then
    reset role; perform set_config('request.jwt.claims', '', true);
    raise exception 'FAIL: % — write raised % (%)', p_label, sqlstate, sqlerrm;
  end;
  reset role; perform set_config('request.jwt.claims', '', true);
  if n is distinct from p_expected then
    raise exception 'FAIL: % — expected % rows affected, got %', p_label, p_expected, n;
  end if;
  raise notice 'ok   % [% affected]', p_label, n;
end;
$$;

-- Asserts that a statement is rejected with the given SQLSTATE and a message
-- matching p_message (ILIKE pattern), so the right safeguard is the one firing.
create function pg_temp.check_denied(p_who text, p_sql text, p_sqlstate text, p_message text, p_label text)
returns void language plpgsql as $$
begin
  perform pg_temp.become(p_who);
  begin
    execute p_sql;
  exception when others then
    reset role; perform set_config('request.jwt.claims', '', true);
    if sqlstate = p_sqlstate and sqlerrm ilike p_message then
      raise notice 'ok   % (rejected: %)', p_label, sqlstate;
      return;
    end if;
    raise exception 'FAIL: % — expected % "%", got % "%"', p_label, p_sqlstate, p_message, sqlstate, sqlerrm;
  end;
  reset role; perform set_config('request.jwt.claims', '', true);
  raise exception 'FAIL: % — expected rejection (% "%"), but the statement succeeded', p_label, p_sqlstate, p_message;
end;
$$;

-- Asserts that an actor can read nothing at all from every public table.
create function pg_temp.check_all_tables(p_who text, p_mode text, p_label text)
returns void language plpgsql as $$
declare
  t text;
  n bigint;
  checked integer := 0;
begin
  for t in select tablename::text from pg_tables where schemaname = 'public' order by 1 loop
    perform pg_temp.become(p_who);
    begin
      execute format('select count(*) from public.%I', t) into n;
      reset role; perform set_config('request.jwt.claims', '', true);
      if p_mode = 'denied' then
        raise exception 'FAIL: % — % was readable', p_label, t;
      elsif n <> 0 then
        raise exception 'FAIL: % — % returned % rows', p_label, t, n;
      end if;
    exception when insufficient_privilege then
      reset role; perform set_config('request.jwt.claims', '', true);
      if p_mode <> 'denied' then
        raise exception 'FAIL: % — % raised permission denied', p_label, t;
      end if;
    end;
    checked := checked + 1;
  end loop;
  raise notice 'ok   % [% tables]', p_label, checked;
end;
$$;

-- Direct SQL deletes from storage.objects are blocked on hosted Supabase by
-- its protect_objects_delete trigger (files must be deleted through the
-- Storage API). There, these checks are skipped here and covered instead by
-- the Storage API delete checks in tests/staging/api_checks.mjs.
create function pg_temp.check_storage_delete(p_who text, p_sql text, p_expected bigint, p_label text)
returns void language plpgsql as $$
begin
  if exists (select 1 from pg_trigger
             where tgrelid = 'storage.objects'::regclass and tgname = 'protect_objects_delete') then
    raise notice 'skip % (Supabase blocks direct deletes; covered by the Storage API live checks)', p_label;
    return;
  end if;
  perform pg_temp.check_affects(p_who, p_sql, p_expected, p_label);
end;
$$;

-- ─── Fixture (as the database owner) ─────────────────────────────────────────
insert into auth.users (id, email, raw_user_meta_data) values
  ('a0000000-0000-0000-0000-000000000000', 'alice@example.test', '{"display_name":"Alice"}'),
  ('b0000000-0000-0000-0000-000000000000', 'bob@example.test',   '{"display_name":"Bob"}'),
  ('c0000000-0000-0000-0000-000000000000', 'carol@example.test', '{"display_name":"Carol"}'),
  ('d0000000-0000-0000-0000-000000000000', 'dave@example.test',  '{"display_name":"Dave"}');

update user_settings set profile_visibility = 'friends'   where user_id = 'a0000000-0000-0000-0000-000000000000';
update user_settings set allow_friend_requests = 'nobody' where user_id = 'c0000000-0000-0000-0000-000000000000';

insert into friendships (user_id, friend_id) values
  ('a0000000-0000-0000-0000-000000000000', 'b0000000-0000-0000-0000-000000000000'),
  ('b0000000-0000-0000-0000-000000000000', 'a0000000-0000-0000-0000-000000000000');
insert into user_blocks (blocker_id, blocked_id) values
  ('a0000000-0000-0000-0000-000000000000', 'd0000000-0000-0000-0000-000000000000');

insert into vehicles (id, owner_id, nickname, visibility, is_active, registration) values
  ('e1000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000000', 'A private',  'private', true,  'AB12CDE'),
  ('e1000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000000', 'A friends',  'friends', false, ''),
  ('e1000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000000', 'A public',   'public',  false, ''),
  ('e1000000-0000-0000-0000-0000000000d1', 'd0000000-0000-0000-0000-000000000000', 'D public',   'public',  true,  '');

insert into vehicle_service_records (id, vehicle_id, owner_id, record_type, performed_on, title) values
  ('e9000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000000', 'service', '2026-09-01', 'Annual service');
insert into vehicle_documents (id, vehicle_id, owner_id, doc_type, title, storage_path, mime_type, size_bytes, status) values
  ('e8000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000000', 'v5c', 'Logbook',
   'a0000000-0000-0000-0000-000000000000/e1000000-0000-0000-0000-000000000001/e8000000-0000-0000-0000-000000000001.pdf', 'application/pdf', 2048, 'ready');
insert into vehicle_modifications (id, vehicle_id, owner_id, name) values
  ('ea000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000000', 'Exhaust on public car'),
  ('ea000000-0000-0000-0000-000000000002', 'e1000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000000', 'Tune on private car');

insert into journeys (id, owner_id, name, status, visibility, started_at, ended_at, distance_km, xp_earned, public_route_polyline) values
  ('e2000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000000', 'Private drive', 'completed', 'private', now() - interval '3 hours', now() - interval '2 hours', 30, 300, 'trimmed1'),
  ('e2000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000000', 'Friends drive', 'completed', 'friends', now() - interval '2 hours', now() - interval '1 hour',  20, 200, 'trimmed2'),
  ('e2000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000000', 'Public drive',  'completed', 'public',  now() - interval '1 hour',  now(),                      10, 100, 'trimmed3'),
  ('e2000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000000', 'Active drive',  'active',    'public',  now(),                     null,                        0,   0, null);
insert into journey_routes (journey_id, owner_id, route_polyline, point_count, start_lat, start_lng) values
  ('e2000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000000', 'fullroute', 3, 54.4, -3.0);
insert into journey_route_points (journey_id, recorded_at, latitude, longitude) values
  ('e2000000-0000-0000-0000-000000000003', now() - interval '60 minutes', 54.40, -3.00),
  ('e2000000-0000-0000-0000-000000000003', now() - interval '30 minutes', 54.45, -3.05),
  ('e2000000-0000-0000-0000-000000000003', now(),                         54.50, -3.10),
  ('e2000000-0000-0000-0000-000000000001', now() - interval '3 hours',    54.40, -3.00),
  ('e2000000-0000-0000-0000-000000000001', now() - interval '2 hours',    54.41, -3.01);

insert into saved_locations (id, owner_id, kind, category, name, lat, lng, visibility, status) values
  ('e3000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000000', 'home',        null,        'A home',          54.4600, -3.0880, 'private', 'active'),
  ('e3000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000000', 'beauty_spot', 'lake',      'A friends spot',  54.4610, -3.0890, 'friends', 'active'),
  ('e3000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000000', 'beauty_spot', 'viewpoint', 'A public spot',   54.4620, -3.0900, 'public',  'active'),
  ('e3000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000000', 'beauty_spot', 'viewpoint', 'A hidden spot',   54.4630, -3.0910, 'public',  'hidden'),
  ('e3000000-0000-0000-0000-0000000000d1', 'd0000000-0000-0000-0000-000000000000', 'beauty_spot', 'coastal',   'D public spot',   54.4640, -3.0920, 'public',  'active');

insert into photos (id, owner_id, vehicle_id, journey_id, bucket, storage_path, thumb_path, mime_type, size_bytes, status) values
  ('e4000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000000', 'e1000000-0000-0000-0000-000000000001', null, 'vehicle-photos',
   'a0000000-0000-0000-0000-000000000000/e1000000-0000-0000-0000-000000000001/p1.jpg', 'a0000000-0000-0000-0000-000000000000/e1000000-0000-0000-0000-000000000001/p1_t.jpg', 'image/jpeg', 1000, 'ready'),
  ('e4000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000000', 'e1000000-0000-0000-0000-000000000003', null, 'vehicle-photos',
   'a0000000-0000-0000-0000-000000000000/e1000000-0000-0000-0000-000000000003/p2.jpg', 'a0000000-0000-0000-0000-000000000000/e1000000-0000-0000-0000-000000000003/p2_t.jpg', 'image/jpeg', 1000, 'ready'),
  ('e4000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000000', 'e1000000-0000-0000-0000-000000000003', null, 'vehicle-photos',
   'a0000000-0000-0000-0000-000000000000/e1000000-0000-0000-0000-000000000003/p3.jpg', null, 'image/jpeg', 1000, 'pending'),
  ('e4000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000000', null, 'e2000000-0000-0000-0000-000000000002', 'journey-photos',
   'a0000000-0000-0000-0000-000000000000/e2000000-0000-0000-0000-000000000002/p4.jpg', null, 'image/jpeg', 1000, 'ready');

insert into groups (id, owner_id, name, is_public, membership_method) values
  ('e5000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000000', 'Public club',  true,  'code'),
  ('e5000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000000', 'Private club', false, 'invite');
insert into group_members (group_id, user_id, role, status) values
  ('e5000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000000', 'owner',  'active'),
  ('e5000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000000', 'admin',  'active'),
  ('e5000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000000', 'member', 'pending'),
  ('e5000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000000', 'owner',  'active'),
  ('e5000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000000', 'member', 'active');
insert into private.join_codes (code, group_id) values ('CLUB2026', 'e5000000-0000-0000-0000-000000000001');

insert into convoys (id, owner_id, group_id, name, visibility, starts_at) values
  ('e6000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000000', null,                                   'Public convoy',  'public',  now()),
  ('e6000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000000', null,                                   'Friends convoy', 'friends', now()),
  ('e6000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000000', null,                                   'Private convoy', 'private', now()),
  ('e6000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000000', 'e5000000-0000-0000-0000-000000000002', 'Club convoy',    'private', now());
insert into convoy_participants (convoy_id, user_id, role)
  select id, 'a0000000-0000-0000-0000-000000000000', 'leader' from convoys;
insert into private.join_codes (code, convoy_id) values ('CONVOY99', 'e6000000-0000-0000-0000-000000000003');

insert into events (id, organiser_id, group_id, name, visibility, starts_at) values
  ('e7000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000000', null,                                   'Public meet',  'public',  now()),
  ('e7000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000000', 'e5000000-0000-0000-0000-000000000002', 'Club meet',    'group',   now()),
  ('e7000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000000', null,                                   'Private meet', 'private', now());
insert into event_rsvps (event_id, user_id, status) values
  ('e7000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000000', 'going'),
  ('e7000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000000', 'invited');

insert into friend_requests (id, from_user_id, to_user_id) values
  ('eb000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000000', 'b0000000-0000-0000-0000-000000000000'),
  ('eb000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000000', 'b0000000-0000-0000-0000-000000000000');

insert into notifications (user_id, type, title) values
  ('a0000000-0000-0000-0000-000000000000', 'system', 'For Alice'),
  ('b0000000-0000-0000-0000-000000000000', 'system', 'For Bob');
insert into user_achievements (user_id, achievement_id) values ('a0000000-0000-0000-0000-000000000000', 'first_drive');
insert into push_devices (user_id, expo_push_token, platform) values ('a0000000-0000-0000-0000-000000000000', 'ExponentPushToken[alice]', 'ios');

insert into storage.objects (bucket_id, name) values
  ('vehicle-photos',    'a0000000-0000-0000-0000-000000000000/e1000000-0000-0000-0000-000000000001/p1.jpg'),
  ('vehicle-photos',    'a0000000-0000-0000-0000-000000000000/e1000000-0000-0000-0000-000000000001/p1_t.jpg'),
  ('vehicle-photos',    'a0000000-0000-0000-0000-000000000000/e1000000-0000-0000-0000-000000000003/p2.jpg'),
  ('vehicle-photos',    'a0000000-0000-0000-0000-000000000000/e1000000-0000-0000-0000-000000000003/p2_t.jpg'),
  ('vehicle-photos',    'a0000000-0000-0000-0000-000000000000/e1000000-0000-0000-0000-000000000003/p3.jpg'),
  ('journey-photos',    'a0000000-0000-0000-0000-000000000000/e2000000-0000-0000-0000-000000000002/p4.jpg'),
  ('location-photos',   'a0000000-0000-0000-0000-000000000000/e3000000-0000-0000-0000-000000000003/orphan.jpg'),
  ('vehicle-documents', 'a0000000-0000-0000-0000-000000000000/e1000000-0000-0000-0000-000000000001/e8000000-0000-0000-0000-000000000001.pdf'),
  ('avatars',           'a0000000-0000-0000-0000-000000000000/avatar.jpg'),
  ('community-media',   'groups/e5000000-0000-0000-0000-000000000001/logo.jpg');

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 1 — current state: no client privileges at all
-- ═════════════════════════════════════════════════════════════════════════════
\echo '--- part 1: current state (no privileges granted to clients)'
select pg_temp.check_all_tables('alice', 'denied', 'signed-in user cannot read any public table');
select pg_temp.check_all_tables('anon',  'denied', 'anonymous caller cannot read any public table');
select pg_temp.check_denied('alice', $q$insert into public.vehicles (owner_id, nickname) values ('a0000000-0000-0000-0000-000000000000', 'x')$q$,
  '42501', 'permission denied%', 'signed-in user cannot write any public table');
select pg_temp.check_denied('alice', $q$select * from public.nearby_spots(54.46, -3.09, 5000)$q$,
  '42501', 'permission denied%', 'signed-in user cannot call Beauty Spot functions yet');

-- ═════════════════════════════════════════════════════════════════════════════
-- PART 2 — worst case: full table privileges granted to both client roles
-- ═════════════════════════════════════════════════════════════════════════════
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
-- The Beauty Spot functions are only ever meant for signed-in users.
grant execute on function public.nearby_spots(double precision, double precision, double precision, integer),
                          public.spots_in_view(double precision, double precision, double precision, double precision, integer)
  to authenticated;

\echo '--- anonymous access'
select pg_temp.check_all_tables('anon', 'empty', 'anonymous caller sees no rows in any table');
select pg_temp.check_denied('anon', $q$insert into public.vehicles (owner_id, nickname) values ('a0000000-0000-0000-0000-000000000000', 'x')$q$,
  '42501', '%row-level security%', 'anonymous caller cannot insert');
select pg_temp.check_affects('anon', $q$update public.profiles set display_name = 'pwned'$q$, 0, 'anonymous caller cannot update');
select pg_temp.check_affects('anon', $q$delete from public.vehicles$q$, 0, 'anonymous caller cannot delete');
select pg_temp.check_denied('anon', $q$select * from public.nearby_spots(54.46, -3.09, 5000)$q$,
  '42501', 'permission denied%', 'anonymous caller cannot search Beauty Spots');

\echo '--- internal objects stay unreachable'
select pg_temp.check_denied('carol', $q$select * from private.join_codes$q$,
  '42501', 'permission denied%', 'join codes cannot be read by clients');
select pg_temp.check_denied('alice', $q$select * from private.storage_delete_queue$q$,
  '42501', 'permission denied%', 'Storage deletion queue cannot be read by clients');
select pg_temp.check_denied('alice', $q$select private.generate_friend_code()$q$,
  '42501', 'permission denied%', 'internal functions cannot be called by clients');

\echo '--- profiles, settings and blocking'
select pg_temp.check_list('alice', $q$select display_name from public.profiles$q$, array['Alice','Bob','Carol'], 'alice sees every profile except the user she blocked');
select pg_temp.check_list('dave',  $q$select display_name from public.profiles$q$, array['Bob','Carol','Dave'], 'a blocked user cannot see the blocker''s profile');
select pg_temp.check_rows('carol', $q$select * from public.profiles$q$, 4, 'an unrelated user sees all basic profiles');
select pg_temp.check_rows('carol', $q$select * from public.user_settings$q$, 1, 'users see only their own settings');
select pg_temp.check_rows('bob',   $q$select * from public.user_settings where user_id = 'a0000000-0000-0000-0000-000000000000'$q$, 0, 'a friend cannot read someone else''s settings');
select pg_temp.check_rows('alice', $q$select * from public.user_blocks$q$, 1, 'the blocker sees their block list');
select pg_temp.check_rows('dave',  $q$select * from public.user_blocks$q$, 0, 'a blocked user cannot discover the block');

\echo '--- XP, level and stats are server-only'
select pg_temp.check_denied('alice', $q$update public.profiles set xp = 999999 where id = 'a0000000-0000-0000-0000-000000000000'$q$,
  '42501', '%cannot be changed by clients%', 'a user cannot raise their own XP');
select pg_temp.check_denied('alice', $q$update public.profiles set level = 99 where id = 'a0000000-0000-0000-0000-000000000000'$q$,
  '428C9', '%can only be updated to DEFAULT%', 'a user cannot set their own level');
select pg_temp.check_denied('alice', $q$update public.profiles set total_distance_km = 99999, total_journeys = 999 where id = 'a0000000-0000-0000-0000-000000000000'$q$,
  '42501', '%cannot be changed by clients%', 'a user cannot inflate their own totals');
select pg_temp.check_denied('alice', $q$update public.profiles set friend_code = 'ZZZZZZZZ' where id = 'a0000000-0000-0000-0000-000000000000'$q$,
  '42501', '%cannot be changed by clients%', 'a user cannot choose their own friend code');
select pg_temp.check_affects('alice', $q$update public.profiles set display_name = 'Alice D', bio = 'Hi' where id = 'a0000000-0000-0000-0000-000000000000'$q$, 1,
  'a user can edit their own name and bio');
select pg_temp.check_affects('carol', $q$update public.profiles set display_name = 'pwned' where id = 'a0000000-0000-0000-0000-000000000000'$q$, 0,
  'a user cannot edit someone else''s profile');
-- Refused before RLS is even reached: clients cannot run the friend-code
-- default. Either refusal (privilege or RLS) is acceptable here.
select pg_temp.check_denied('alice', $q$insert into public.profiles (id) values ('a0000000-0000-0000-0000-00000000000f')$q$,
  '42501', '%', 'clients cannot create profiles');
select pg_temp.check_affects('alice', $q$delete from public.profiles where id = 'a0000000-0000-0000-0000-000000000000'$q$, 0,
  'clients cannot delete profiles directly');
select pg_temp.check_denied('alice', $q$update public.journeys set xp_earned = 5000 where id = 'e2000000-0000-0000-0000-000000000003'$q$,
  '42501', '%cannot be changed by clients%', 'a user cannot change the XP earned by a journey');
select pg_temp.check_affects('alice', $q$delete from public.user_achievements$q$, 0, 'a user cannot remove or re-trigger achievements');
select pg_temp.check_denied('alice', $q$insert into public.user_achievements (user_id, achievement_id) values ('a0000000-0000-0000-0000-000000000000', 'road_warrior')$q$,
  '42501', '%row-level security%', 'a user cannot award themselves an achievement');

\echo '--- vehicles: private / friends / public'
select pg_temp.check_list('alice', $q$select nickname from public.vehicles$q$, array['A friends','A private','A public'], 'owner sees all own vehicles (blocked user''s hidden)');
select pg_temp.check_list('bob',   $q$select nickname from public.vehicles$q$, array['A friends','A public','D public'], 'a friend sees friends and public vehicles');
select pg_temp.check_list('carol', $q$select nickname from public.vehicles$q$, array['A public','D public'], 'a stranger sees public vehicles only');
select pg_temp.check_list('dave',  $q$select nickname from public.vehicles$q$, array['D public'], 'a blocked user sees none of the blocker''s vehicles');
select pg_temp.check_affects('carol', $q$update public.vehicles set nickname = 'pwned' where id = 'e1000000-0000-0000-0000-000000000003'$q$, 0, 'a user cannot edit someone else''s vehicle');
select pg_temp.check_affects('carol', $q$delete from public.vehicles where id = 'e1000000-0000-0000-0000-000000000003'$q$, 0, 'a user cannot delete someone else''s vehicle');
select pg_temp.check_denied('carol', $q$insert into public.vehicles (owner_id, nickname) values ('a0000000-0000-0000-0000-000000000000', 'planted')$q$,
  '42501', '%row-level security%', 'a user cannot create a vehicle for someone else');
select pg_temp.check_denied('alice', $q$update public.vehicles set owner_id = 'c0000000-0000-0000-0000-000000000000' where id = 'e1000000-0000-0000-0000-000000000002'$q$,
  '42501', '%cannot be changed by clients%', 'a user cannot hand a vehicle to someone else');
select pg_temp.check_affects('alice', $q$insert into public.vehicles (owner_id, nickname) values ('a0000000-0000-0000-0000-000000000000', 'New car')$q$, 1, 'a user can add their own vehicle');
select pg_temp.check_list('bob',   $q$select name from public.vehicle_modifications$q$, array['Exhaust on public car'], 'modifications follow the vehicle''s visibility');

\echo '--- vehicle documents and service records stay private'
select pg_temp.check_rows('alice', $q$select * from public.vehicle_documents$q$, 1, 'owner sees their documents');
select pg_temp.check_rows('bob',   $q$select * from public.vehicle_documents$q$, 0, 'a friend cannot see documents');
select pg_temp.check_rows('carol', $q$select * from public.vehicle_documents$q$, 0, 'a stranger cannot see documents');
select pg_temp.check_rows('bob',   $q$select * from public.vehicle_service_records$q$, 0, 'a friend cannot see service history');
select pg_temp.check_denied('carol', $q$insert into public.vehicle_documents (vehicle_id, owner_id, doc_type, storage_path, mime_type, size_bytes)
    values ('e1000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000000', 'mot', 'c0000000-0000-0000-0000-000000000000/x.pdf', 'application/pdf', 10)$q$,
  '42501', '%row-level security%', 'a user cannot add a document to someone else''s account');
select pg_temp.check_denied('carol', $q$insert into public.vehicle_documents (vehicle_id, owner_id, doc_type, storage_path, mime_type, size_bytes)
    values ('e1000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000000', 'mot', 'c0000000-0000-0000-0000-000000000000/x.pdf', 'application/pdf', 10)$q$,
  '23503', '%foreign key%', 'a user cannot attach a document to someone else''s vehicle');
select pg_temp.check_denied('alice', $q$insert into public.vehicle_documents (vehicle_id, owner_id, doc_type, storage_path, mime_type, size_bytes)
    values ('e1000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000000', 'mot', 'b0000000-0000-0000-0000-000000000000/bobs.pdf', 'application/pdf', 10)$q$,
  '23514', '%path_in_owner_folder%', 'a document row cannot point at another user''s file');
select pg_temp.check_denied('alice', $q$insert into public.vehicle_documents (vehicle_id, owner_id, doc_type, storage_path, mime_type, size_bytes, status)
    values ('e1000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000000', 'mot', 'a0000000-0000-0000-0000-000000000000/new.pdf', 'application/pdf', 10, 'ready')$q$,
  '42501', '%row-level security%', 'a client-created document starts pending');
select pg_temp.check_denied('alice', $q$update public.vehicle_documents set storage_path = 'a0000000-0000-0000-0000-000000000000/other.pdf'$q$,
  '42501', '%cannot be changed by clients%', 'a document''s file path cannot be changed by clients');
select pg_temp.check_affects('alice', $q$update public.vehicle_documents set title = 'V5C logbook'$q$, 1, 'owner can rename a document');

\echo '--- journeys, routes and raw GPS points'
select pg_temp.check_list('alice', $q$select name from public.journeys$q$, array['Active drive','Friends drive','Private drive','Public drive'], 'owner sees all own journeys');
select pg_temp.check_list('bob',   $q$select name from public.journeys$q$, array['Friends drive','Public drive'], 'a friend sees completed friends and public journeys');
select pg_temp.check_list('carol', $q$select name from public.journeys$q$, array['Public drive'], 'a stranger sees completed public journeys only');
select pg_temp.check_rows('dave',  $q$select * from public.journeys$q$, 0, 'a blocked user sees none of the blocker''s journeys');
select pg_temp.check_rows('alice', $q$select * from public.journey_route_points$q$, 5, 'owner sees their raw GPS points');
select pg_temp.check_rows('bob',   $q$select * from public.journey_route_points$q$, 0, 'a friend never sees raw GPS points');
select pg_temp.check_rows('carol', $q$select * from public.journey_route_points where journey_id = 'e2000000-0000-0000-0000-000000000003'$q$, 0,
  'raw GPS points of a public journey stay private');
select pg_temp.check_rows('alice', $q$select * from public.journey_routes$q$, 1, 'owner sees their full route summary');
select pg_temp.check_rows('carol', $q$select * from public.journey_routes$q$, 0, 'the full route summary of a public journey stays private');
select pg_temp.check_list('carol', $q$select public_route_polyline from public.journeys$q$, array['trimmed3'], 'others see only the trimmed public route');
select pg_temp.check_denied('alice', $q$update public.journeys set distance_km = 9999 where id = 'e2000000-0000-0000-0000-000000000003'$q$,
  '42501', '%cannot be changed by clients%', 'a user cannot change a journey''s distance');
select pg_temp.check_denied('alice', $q$update public.journeys set status = 'completed', ended_at = now() where id = 'e2000000-0000-0000-0000-000000000004'$q$,
  '42501', '%cannot be changed by clients%', 'a user cannot complete a journey directly');
select pg_temp.check_affects('alice', $q$update public.journeys set name = 'Lakes loop', visibility = 'friends' where id = 'e2000000-0000-0000-0000-000000000003'$q$, 1,
  'owner can rename a journey and change its visibility');
select pg_temp.check_affects('bob', $q$update public.journeys set name = 'pwned' where id = 'e2000000-0000-0000-0000-000000000002'$q$, 0,
  'a friend cannot edit a journey they can see');
select pg_temp.check_denied('alice', $q$insert into public.journeys (owner_id, started_at) values ('a0000000-0000-0000-0000-000000000000', now())$q$,
  '42501', '%row-level security%', 'journeys are started by the server only');
select pg_temp.check_denied('alice', $q$insert into public.journey_route_points (journey_id, recorded_at, latitude, longitude)
    values ('e2000000-0000-0000-0000-000000000004', now(), 54, -3)$q$,
  '42501', '%row-level security%', 'route points are written by the server only');
select pg_temp.check_affects('alice', $q$update public.journey_routes set route_polyline = 'x'$q$, 0, 'route summaries are written by the server only');
select pg_temp.check_affects('carol', $q$delete from public.journeys where id = 'e2000000-0000-0000-0000-000000000003'$q$, 0, 'a user cannot delete someone else''s journey');
select pg_temp.check_rows('bob', $q$select * from public.journey_categories$q$, 8, 'shared default categories are visible to everyone');

\echo '--- photos follow their parent''s visibility'
select pg_temp.check_rows('alice', $q$select * from public.photos$q$, 4, 'owner sees all own photos (incl. pending)');
select pg_temp.check_rows('bob',   $q$select * from public.photos$q$, 2, 'a friend sees photos of friends/public items only');
select pg_temp.check_rows('carol', $q$select * from public.photos$q$, 1, 'a stranger sees photos of public items only');
select pg_temp.check_rows('dave',  $q$select * from public.photos$q$, 0, 'a blocked user sees none of the blocker''s photos');
select pg_temp.check_denied('alice', $q$insert into public.photos (owner_id, vehicle_id, bucket, storage_path, mime_type, size_bytes, status)
    values ('a0000000-0000-0000-0000-000000000000', 'e1000000-0000-0000-0000-000000000003', 'vehicle-photos', 'a0000000-0000-0000-0000-000000000000/n.jpg', 'image/jpeg', 10, 'ready')$q$,
  '42501', '%row-level security%', 'a client-created photo starts pending');
select pg_temp.check_denied('alice', $q$insert into public.photos (owner_id, vehicle_id, bucket, storage_path, mime_type, size_bytes)
    values ('a0000000-0000-0000-0000-000000000000', 'e1000000-0000-0000-0000-000000000003', 'vehicle-photos', 'b0000000-0000-0000-0000-000000000000/bobs.jpg', 'image/jpeg', 10)$q$,
  '23514', '%paths_in_owner_folder%', 'a photo row cannot point at another user''s file');
select pg_temp.check_denied('carol', $q$insert into public.photos (owner_id, vehicle_id, bucket, storage_path, mime_type, size_bytes)
    values ('c0000000-0000-0000-0000-000000000000', 'e1000000-0000-0000-0000-000000000003', 'vehicle-photos', 'c0000000-0000-0000-0000-000000000000/c.jpg', 'image/jpeg', 10)$q$,
  '23503', '%foreign key%', 'a user cannot add photos to someone else''s vehicle');
select pg_temp.check_denied('carol', $q$insert into public.photos (owner_id, location_id, bucket, storage_path, mime_type, size_bytes)
    values ('c0000000-0000-0000-0000-000000000000', 'e3000000-0000-0000-0000-000000000003', 'location-photos', 'c0000000-0000-0000-0000-000000000000/c.jpg', 'image/jpeg', 10)$q$,
  '42501', '%row-level security%', 'a user cannot add photos to someone else''s Beauty Spot');
select pg_temp.check_denied('alice', $q$update public.photos set status = 'ready' where id = 'e4000000-0000-0000-0000-000000000003'$q$,
  '42501', '%cannot be changed by clients%', 'a photo cannot be marked ready by the client');
select pg_temp.check_affects('alice', $q$update public.photos set caption = 'Side profile' where id = 'e4000000-0000-0000-0000-000000000002'$q$, 1, 'owner can caption a photo');
select pg_temp.check_affects('bob',   $q$update public.photos set caption = 'pwned'$q$, 0, 'a user cannot edit someone else''s photos');

\echo '--- saved locations and Beauty Spots'
select pg_temp.check_list('alice', $q$select name from public.saved_locations$q$, array['A friends spot','A hidden spot','A home','A public spot'], 'owner sees all own locations, including hidden');
select pg_temp.check_list('bob',   $q$select name from public.saved_locations$q$, array['A friends spot','A public spot','D public spot'], 'a friend sees friends and public spots, never Home');
select pg_temp.check_list('carol', $q$select name from public.saved_locations$q$, array['A public spot','D public spot'], 'a stranger sees public spots only');
select pg_temp.check_list('dave',  $q$select name from public.saved_locations$q$, array['D public spot'], 'a blocked user sees none of the blocker''s spots');
select pg_temp.check_list('carol', $q$select name from public.nearby_spots(54.46, -3.09, 5000)$q$, array['A public spot','D public spot'], 'nearby search: stranger finds public spots only');
select pg_temp.check_list('bob',   $q$select name from public.nearby_spots(54.46, -3.09, 5000)$q$, array['A friends spot','A public spot','D public spot'], 'nearby search: friend also finds friends-only spots');
select pg_temp.check_list('alice', $q$select name from public.nearby_spots(54.46, -3.09, 5000)$q$, array['A friends spot','A public spot'], 'nearby search excludes hidden spots and blocked users');
select pg_temp.check_list('dave',  $q$select name from public.spots_in_view(54.0, -3.5, 55.0, -2.5)$q$, array['D public spot'], 'map-view search respects blocking');
select pg_temp.check_denied('alice', $q$update public.saved_locations set status = 'active' where id = 'e3000000-0000-0000-0000-000000000004'$q$,
  '42501', '%cannot be changed by clients%', 'an owner cannot un-hide a moderated spot');
select pg_temp.check_denied('alice', $q$update public.saved_locations set visibility = 'public' where id = 'e3000000-0000-0000-0000-000000000001'$q$,
  '23514', '%home_work_private%', 'Home can never be made public');
select pg_temp.check_denied('alice', $q$insert into public.saved_locations (owner_id, kind, name, lat, lng, status)
    values ('a0000000-0000-0000-0000-000000000000', 'poi', 'x', 54, -3, 'hidden')$q$,
  '42501', '%row-level security%', 'clients cannot set a moderation status');
select pg_temp.check_affects('carol', $q$update public.saved_locations set name = 'pwned' where id = 'e3000000-0000-0000-0000-000000000003'$q$, 0,
  'a user cannot edit someone else''s spot');
select pg_temp.check_affects('alice', $q$insert into public.saved_locations (owner_id, kind, name, lat, lng) values ('a0000000-0000-0000-0000-000000000000', 'car_park', 'Car park', 54, -3)$q$, 1,
  'a user can save their own location');

\echo '--- friends and friend requests'
select pg_temp.check_rows('alice', $q$select * from public.friendships$q$, 2, 'a user sees their own friendships');
select pg_temp.check_rows('carol', $q$select * from public.friendships$q$, 0, 'a user cannot see other people''s friendships');
select pg_temp.check_denied('carol', $q$insert into public.friendships (user_id, friend_id) values ('c0000000-0000-0000-0000-000000000000', 'a0000000-0000-0000-0000-000000000000')$q$,
  '42501', '%row-level security%', 'friendships cannot be created by clients');
select pg_temp.check_rows('bob',   $q$select * from public.friend_requests$q$, 2, 'the recipient sees incoming requests');
select pg_temp.check_rows('carol', $q$select * from public.friend_requests$q$, 1, 'the sender sees their own request');
select pg_temp.check_rows('alice', $q$select * from public.friend_requests$q$, 0, 'uninvolved users see no requests');
select pg_temp.check_denied('alice', $q$insert into public.friend_requests (from_user_id, to_user_id) values ('a0000000-0000-0000-0000-000000000000', 'c0000000-0000-0000-0000-000000000000')$q$,
  '42501', '%row-level security%', 'no requests to a user who accepts none');
select pg_temp.check_denied('dave', $q$insert into public.friend_requests (from_user_id, to_user_id) values ('d0000000-0000-0000-0000-000000000000', 'a0000000-0000-0000-0000-000000000000')$q$,
  '42501', '%row-level security%', 'a blocked user cannot send a friend request');
select pg_temp.check_denied('alice', $q$insert into public.friend_requests (from_user_id, to_user_id) values ('a0000000-0000-0000-0000-000000000000', 'b0000000-0000-0000-0000-000000000000')$q$,
  '42501', '%row-level security%', 'no request to someone already a friend');
select pg_temp.check_denied('carol', $q$insert into public.friend_requests (from_user_id, to_user_id) values ('a0000000-0000-0000-0000-000000000000', 'd0000000-0000-0000-0000-000000000000')$q$,
  '42501', '%row-level security%', 'a user cannot send a request as someone else');
select pg_temp.check_affects('carol', $q$insert into public.friend_requests (from_user_id, to_user_id) values ('c0000000-0000-0000-0000-000000000000', 'd0000000-0000-0000-0000-000000000000')$q$, 1,
  'a user can send a normal friend request');
select pg_temp.check_denied('bob', $q$update public.friend_requests set status = 'accepted', responded_at = now() where id = 'eb000000-0000-0000-0000-000000000001'$q$,
  '42501', '%row-level security%', 'accepting (which creates friendships) is server-only');
select pg_temp.check_denied('dave', $q$update public.friend_requests set from_user_id = 'a0000000-0000-0000-0000-000000000000' where from_user_id = 'c0000000-0000-0000-0000-000000000000'$q$,
  '42501', '%cannot be changed by clients%', 'a recipient cannot forge who a request came from');
select pg_temp.check_affects('alice', $q$update public.friend_requests set status = 'declined', responded_at = now() where id = 'eb000000-0000-0000-0000-000000000001'$q$, 0,
  'only the recipient can decline');
select pg_temp.check_affects('bob', $q$update public.friend_requests set status = 'declined', responded_at = now() where id = 'eb000000-0000-0000-0000-000000000001'$q$, 1,
  'the recipient can decline');
select pg_temp.check_affects('dave', $q$update public.friend_requests set status = 'cancelled', responded_at = now() where id = 'eb000000-0000-0000-0000-000000000002'$q$, 1,
  'the sender can cancel');

\echo '--- private groups'
select pg_temp.check_list('carol', $q$select name from public.groups$q$, array['Public club'], 'a non-member cannot see a private group');
select pg_temp.check_list('bob',   $q$select name from public.groups$q$, array['Private club','Public club'], 'a member sees the private group');
select pg_temp.check_rows('carol', $q$select * from public.group_members where group_id = 'e5000000-0000-0000-0000-000000000002'$q$, 0, 'a non-member cannot list a private group''s members');
select pg_temp.check_rows('carol', $q$select * from public.group_members where group_id = 'e5000000-0000-0000-0000-000000000001'$q$, 3, 'anyone can list a public group''s members');
select pg_temp.check_denied('carol', $q$insert into public.group_members (group_id, user_id) values ('e5000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000000')$q$,
  '42501', '%row-level security%', 'a user cannot add themselves to a private group');
select pg_temp.check_denied('carol', $q$insert into public.group_members (group_id, user_id) values ('e5000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000000')$q$,
  '42501', '%row-level security%', 'joining any group goes through the server');
select pg_temp.check_denied('carol', $q$insert into public.groups (owner_id, name) values ('c0000000-0000-0000-0000-000000000000', 'x')$q$,
  '42501', '%row-level security%', 'groups are created by the server only');
select pg_temp.check_affects('bob',   $q$update public.groups set description = 'Updated' where id = 'e5000000-0000-0000-0000-000000000001'$q$, 1, 'a group admin can edit the group');
select pg_temp.check_denied('bob',    $q$update public.groups set owner_id = 'b0000000-0000-0000-0000-000000000000' where id = 'e5000000-0000-0000-0000-000000000001'$q$,
  '42501', '%cannot be changed by clients%', 'an admin cannot take ownership of a group');
select pg_temp.check_affects('bob',   $q$update public.groups set name = 'pwned' where id = 'e5000000-0000-0000-0000-000000000002'$q$, 0, 'an ordinary member cannot edit the group');
select pg_temp.check_affects('carol', $q$update public.groups set name = 'pwned'$q$, 0, 'a non-member cannot edit any group');
select pg_temp.check_affects('carol', $q$delete from public.groups$q$, 0, 'a non-owner cannot delete a group');

\echo '--- private convoys'
select pg_temp.check_list('carol', $q$select name from public.convoys$q$, array['Public convoy'], 'a stranger sees public convoys only');
select pg_temp.check_list('bob',   $q$select name from public.convoys$q$, array['Club convoy','Friends convoy','Public convoy'], 'a friend and group member sees friends and group convoys, not private');
select pg_temp.check_rows('dave',  $q$select * from public.convoys$q$, 0, 'a blocked user sees none of the blocker''s convoys');
select pg_temp.check_rows('carol', $q$select * from public.convoy_participants$q$, 1, 'participants of invisible convoys stay hidden');
select pg_temp.check_denied('carol', $q$insert into public.convoy_participants (convoy_id, user_id) values ('e6000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000000')$q$,
  '42501', '%row-level security%', 'a user cannot join a private convoy directly');
select pg_temp.check_denied('carol', $q$insert into public.convoy_participants (convoy_id, user_id) values ('e6000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000000')$q$,
  '42501', '%row-level security%', 'joining any convoy goes through the server (capacity rules)');
select pg_temp.check_affects('bob',   $q$update public.convoys set name = 'pwned'$q$, 0, 'only the leader can edit a convoy');
select pg_temp.check_denied('alice',  $q$update public.convoys set owner_id = 'c0000000-0000-0000-0000-000000000000' where id = 'e6000000-0000-0000-0000-000000000001'$q$,
  '42501', '%cannot be changed by clients%', 'a leader cannot hand a convoy to someone else');
select pg_temp.check_affects('alice', $q$delete from public.convoy_participants where user_id = 'a0000000-0000-0000-0000-000000000000'$q$, 0, 'the leader cannot silently leave their convoy');

\echo '--- private events'
select pg_temp.check_list('bob',   $q$select name from public.events$q$, array['Club meet','Public meet'], 'a friend does not see a private event they were not invited to');
select pg_temp.check_list('carol', $q$select name from public.events$q$, array['Private meet','Public meet'], 'an invited user sees the private event');
select pg_temp.check_rows('dave',  $q$select * from public.events$q$, 0, 'a blocked user sees none of the blocker''s events');
select pg_temp.check_rows('bob',   $q$select * from public.event_rsvps$q$, 1, 'RSVPs of invisible events stay hidden');
select pg_temp.check_denied('carol', $q$insert into public.event_rsvps (event_id, user_id, status) values ('e7000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000000', 'going')$q$,
  '42501', '%row-level security%', 'RSVPs go through the server (capacity rules)');
select pg_temp.check_denied('bob', $q$insert into public.events (organiser_id, group_id, name, visibility, starts_at)
    values ('b0000000-0000-0000-0000-000000000000', 'e5000000-0000-0000-0000-000000000002', 'x', 'group', now())$q$,
  '42501', '%row-level security%', 'an ordinary member cannot create group events');
select pg_temp.check_affects('carol', $q$update public.events set name = 'pwned'$q$, 0, 'a guest cannot edit an event');
select pg_temp.check_denied('alice', $q$update public.events set organiser_id = 'c0000000-0000-0000-0000-000000000000' where id = 'e7000000-0000-0000-0000-000000000001'$q$,
  '42501', '%cannot be changed by clients%', 'an organiser cannot hand an event to someone else');
select pg_temp.check_affects('carol', $q$delete from public.event_rsvps where user_id = 'c0000000-0000-0000-0000-000000000000'$q$, 1, 'a guest can withdraw their RSVP');
select pg_temp.check_list('carol', $q$select name from public.events$q$, array['Public meet'], 'after withdrawing, the private event is hidden again');

\echo '--- group membership management'
select pg_temp.check_affects('bob', $q$update public.group_members set status = 'active' where user_id = 'c0000000-0000-0000-0000-000000000000' and group_id = 'e5000000-0000-0000-0000-000000000001'$q$, 1,
  'a group admin can approve a pending member');
select pg_temp.check_denied('bob', $q$update public.group_members set role = 'admin' where user_id = 'c0000000-0000-0000-0000-000000000000' and group_id = 'e5000000-0000-0000-0000-000000000001'$q$,
  '42501', '%row-level security%', 'an admin cannot promote members to admin');
select pg_temp.check_denied('bob', $q$update public.group_members set group_id = 'e5000000-0000-0000-0000-000000000002' where user_id = 'c0000000-0000-0000-0000-000000000000' and group_id = 'e5000000-0000-0000-0000-000000000001'$q$,
  '42501', '%cannot be changed by clients%', 'an admin cannot move a member into another (private) group');
select pg_temp.check_denied('alice', $q$update public.group_members set role = 'owner' where user_id = 'b0000000-0000-0000-0000-000000000000' and group_id = 'e5000000-0000-0000-0000-000000000001'$q$,
  '42501', '%row-level security%', 'ownership cannot be transferred directly');
select pg_temp.check_affects('alice', $q$update public.group_members set role = 'admin' where user_id = 'c0000000-0000-0000-0000-000000000000' and group_id = 'e5000000-0000-0000-0000-000000000001'$q$, 1,
  'the owner can promote a member to admin');
select pg_temp.check_affects('alice', $q$delete from public.group_members where user_id = 'a0000000-0000-0000-0000-000000000000'$q$, 0, 'the owner cannot leave without transferring ownership');
select pg_temp.check_affects('bob', $q$delete from public.group_members where user_id = 'b0000000-0000-0000-0000-000000000000' and group_id = 'e5000000-0000-0000-0000-000000000002'$q$, 1,
  'a member can leave a group');
select pg_temp.check_list('bob', $q$select name from public.groups$q$, array['Public club'], 'after leaving, the private group is hidden');
select pg_temp.check_list('bob', $q$select name from public.convoys$q$, array['Friends convoy','Public convoy'], 'after leaving, the group''s private convoy is hidden');

\echo '--- notifications, achievements, reports, push devices'
select pg_temp.check_list('alice', $q$select title from public.notifications$q$, array['For Alice'], 'users see only their own notifications');
select pg_temp.check_affects('alice', $q$update public.notifications set read_at = now()$q$, 1, 'a user can mark their notifications read');
select pg_temp.check_denied('alice', $q$update public.notifications set title = 'forged'$q$, '42501', '%cannot be changed by clients%', 'notification content cannot be changed');
select pg_temp.check_affects('bob', $q$update public.notifications set read_at = now() where title = 'For Alice'$q$, 0, 'a user cannot touch someone else''s notifications');
select pg_temp.check_denied('alice', $q$insert into public.notifications (user_id, type, title) values ('b0000000-0000-0000-0000-000000000000', 'system', 'spam')$q$,
  '42501', '%row-level security%', 'notifications are created by the server only');
select pg_temp.check_rows('bob',   $q$select * from public.user_achievements$q$, 1, 'friends see achievements of a friends-only profile');
select pg_temp.check_rows('carol', $q$select * from public.user_achievements$q$, 0, 'strangers do not see achievements of a friends-only profile');
select pg_temp.check_rows('dave',  $q$select * from public.user_achievements$q$, 0, 'a blocked user does not see achievements');
select pg_temp.check_rows('carol', $q$select * from public.achievements$q$, 6, 'the achievement catalogue is visible to signed-in users');
select pg_temp.check_affects('carol', $q$insert into public.content_reports (reporter_id, target_type, target_id, reason) values ('c0000000-0000-0000-0000-000000000000', 'location', 'e3000000-0000-0000-0000-000000000003', 'spam')$q$, 1,
  'a user can report content');
select pg_temp.check_denied('carol', $q$insert into public.content_reports (reporter_id, target_type, target_id, reason, status) values ('c0000000-0000-0000-0000-000000000000', 'location', 'e3000000-0000-0000-0000-0000000000d1', 'spam', 'actioned')$q$,
  '42501', '%row-level security%', 'a reporter cannot resolve their own report');
select pg_temp.check_rows('alice', $q$select * from public.content_reports$q$, 0, 'reports are not visible to the reported user');
select pg_temp.check_rows('bob',   $q$select * from public.push_devices$q$, 0, 'push tokens are private');

\echo '--- Storage objects'
select pg_temp.check_rows('alice', $q$select * from storage.objects$q$, 8, 'owner can read own photos, thumbnails, document and avatar');
select pg_temp.check_rows('bob',   $q$select * from storage.objects$q$, 3, 'a friend can read files of friends/public items only');
select pg_temp.check_rows('carol', $q$select * from storage.objects$q$, 2, 'a stranger can read files of public items only');
select pg_temp.check_rows('dave',  $q$select * from storage.objects$q$, 0, 'a blocked user can read none of the blocker''s files');
select pg_temp.check_rows('anon',  $q$select * from storage.objects$q$, 0, 'anonymous callers can read no private files');
select pg_temp.check_rows('bob',   $q$select * from storage.objects where bucket_id = 'vehicle-documents'$q$, 0, 'a friend cannot read vehicle documents');
select pg_temp.check_rows('carol', $q$select * from storage.objects where name like '%/p3.jpg'$q$, 0, 'files of pending photos are not readable by others');
select pg_temp.check_rows('alice', $q$select * from storage.objects where name like '%orphan.jpg'$q$, 0, 'files with no metadata row are readable by no one');
select pg_temp.check_denied('carol', $q$insert into storage.objects (bucket_id, name) values ('vehicle-photos', 'a0000000-0000-0000-0000-000000000000/x/evil.jpg')$q$,
  '42501', '%row-level security%', 'a user cannot upload into someone else''s photo folder');
select pg_temp.check_affects('carol', $q$insert into storage.objects (bucket_id, name) values ('vehicle-photos', 'c0000000-0000-0000-0000-000000000000/x/mine.jpg')$q$, 1,
  'a user can upload into their own photo folder');
select pg_temp.check_denied('carol', $q$insert into storage.objects (bucket_id, name) values ('vehicle-documents', 'a0000000-0000-0000-0000-000000000000/x.pdf')$q$,
  '42501', '%row-level security%', 'a user cannot upload into someone else''s document folder');
select pg_temp.check_denied('carol', $q$insert into storage.objects (bucket_id, name) values ('avatars', 'a0000000-0000-0000-0000-000000000000/fake.jpg')$q$,
  '42501', '%row-level security%', 'a user cannot replace someone else''s avatar');
select pg_temp.check_affects('carol', $q$insert into storage.objects (bucket_id, name) values ('avatars', 'c0000000-0000-0000-0000-000000000000/me.jpg')$q$, 1,
  'a user can upload their own avatar');
select pg_temp.check_denied('anon', $q$insert into storage.objects (bucket_id, name) values ('avatars', 'a0000000-0000-0000-0000-000000000000/x.jpg')$q$,
  '42501', '%row-level security%', 'anonymous callers cannot upload');
select pg_temp.check_affects('bob', $q$insert into storage.objects (bucket_id, name) values ('community-media', 'groups/e5000000-0000-0000-0000-000000000001/banner.jpg')$q$, 1,
  'a group admin can upload the group''s images');
select pg_temp.check_denied('carol', $q$insert into storage.objects (bucket_id, name) values ('community-media', 'groups/e5000000-0000-0000-0000-000000000002/x.jpg')$q$,
  '42501', '%row-level security%', 'a non-admin cannot upload group images');
select pg_temp.check_denied('carol', $q$insert into storage.objects (bucket_id, name) values ('community-media', 'groups/not-a-uuid/x.jpg')$q$,
  '42501', '%row-level security%', 'malformed community paths are rejected cleanly');
select pg_temp.check_affects('alice', $q$insert into storage.objects (bucket_id, name) values ('community-media', 'events/e7000000-0000-0000-0000-000000000001/cover.jpg')$q$, 1,
  'an organiser can upload the event cover');
select pg_temp.check_denied('carol', $q$insert into storage.objects (bucket_id, name) values ('community-media', 'events/e7000000-0000-0000-0000-000000000001/x.jpg')$q$,
  '42501', '%row-level security%', 'a guest cannot upload event images');
select pg_temp.check_storage_delete('carol', $q$delete from storage.objects where name like 'a0000000-0000-0000-0000-000000000000/%'$q$, 0,
  'a user cannot delete someone else''s files');
select pg_temp.check_affects('bob', $q$update storage.objects set name = 'b0000000-0000-0000-0000-000000000000/stolen.jpg' where name like '%/p2.jpg'$q$, 0,
  'a user cannot rename or move someone else''s files');
select pg_temp.check_storage_delete('alice', $q$delete from storage.objects where bucket_id = 'vehicle-documents'$q$, 1,
  'an owner can delete their own document file');

\echo '=== ALL RLS AND SECURITY TESTS PASSED ==='
