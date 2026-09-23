-- ============================================================================
-- Schema smoke tests.
-- Run by supabase/tests/local/run.sh against a throwaway database after the
-- stub and all migrations, and by the staging workflow against the real
-- staging project INSIDE A TRANSACTION THAT IS ALWAYS ROLLED BACK (it writes
-- test rows, so never run it any other way against a hosted project).
-- Any failed check raises and stops the run.
-- Per-user RLS behaviour is covered separately in Phase 2.
-- ============================================================================
\set ON_ERROR_STOP on
\set QUIET on
-- Discard result rows; the NOTICE lines (stderr) and \echo lines carry the report.
\o /dev/null
set client_min_messages = notice;

create function pg_temp.ok(p_condition boolean, p_label text)
returns void language plpgsql as $$
begin
  if p_condition is distinct from true then
    raise exception 'FAIL: %', p_label;
  end if;
  raise notice 'ok   %', p_label;
end;
$$;

create function pg_temp.expect_error(p_sql text, p_sqlstate text, p_label text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlstate = p_sqlstate then
      raise notice 'ok   % (rejected: %)', p_label, sqlstate;
      return;
    end if;
    raise exception 'FAIL: % — expected SQLSTATE %, got % (%)', p_label, p_sqlstate, sqlstate, sqlerrm;
  end;
  raise exception 'FAIL: % — expected SQLSTATE %, but the statement succeeded', p_label, p_sqlstate;
end;
$$;

-- ─── 1. Structure and exposure ───────────────────────────────────────────────
\echo '--- structure and exposure'
select pg_temp.ok(
  (select array_agg(tablename::text order by tablename) from pg_tables where schemaname = 'public') =
  array['achievements','content_reports','convoy_participants','convoys','event_rsvps','events',
        'friend_requests','friendships','group_members','groups','journey_categories',
        'journey_route_points','journey_routes','journeys','notifications','photos','profiles','push_devices',
        'saved_locations','user_achievements','user_blocks','user_settings','vehicle_documents',
        'vehicle_modifications','vehicle_service_records','vehicles'],
  'public schema contains exactly the 26 DriveOS tables');

select pg_temp.ok(
  not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity),
  'RLS is enabled on every public table');

select pg_temp.ok(
  not exists (select 1 from pg_tables t
              where t.schemaname = 'public'
                and not exists (select 1 from pg_policies p
                                where p.schemaname = 'public' and p.tablename = t.tablename)),
  'every public table has at least one policy');

select pg_temp.ok(
  not exists (
    select 1 from pg_tables t, unnest(array['anon','authenticated']) r(role)
    where t.schemaname = 'public'
      and has_table_privilege(r.role, format('public.%I', t.tablename), 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')),
  'anon and authenticated hold no privileges on any public table');

select pg_temp.ok(
  not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace,
         unnest(array['anon','authenticated']) r(role)
    where n.nspname = 'public' and has_function_privilege(r.role, p.oid, 'EXECUTE')),
  'anon and authenticated cannot execute any public function');

select pg_temp.ok(not has_schema_privilege('anon', 'private', 'USAGE'), 'anon has no access to the private schema');

select pg_temp.ok(
  has_function_privilege('authenticated', 'private.can_view(uuid,text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.handle_new_user()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.queue_storage_delete()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.generate_friend_code()', 'EXECUTE')
  and not has_function_privilege('anon', 'private.can_view(uuid,text)', 'EXECUTE'),
  'authenticated may call RLS helpers only; trigger/internal functions are not callable');

select pg_temp.ok(
  not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relname = 'spatial_ref_sys'),
  'PostGIS objects are not in the public schema');

select pg_temp.ok(
  (select count(*) from storage.buckets where id in
     ('avatars','community-media','vehicle-photos','journey-photos','location-photos','vehicle-documents')) = 6
  and (select public from storage.buckets where id = 'vehicle-documents') = false
  and (select public from storage.buckets where id = 'vehicle-photos') = false
  and (select public from storage.buckets where id = 'avatars') = true,
  '6 Storage buckets; documents and photos private, avatars public');

select pg_temp.ok(
  (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname like 'driveos\_%') = 12,
  '12 DriveOS policies on storage.objects');

select pg_temp.ok(private.try_uuid('not-a-uuid') is null and private.try_uuid('00000000-0000-0000-0000-000000000001') is not null,
  'try_uuid never raises on malformed input');

-- ─── 2. Seed data ────────────────────────────────────────────────────────────
\echo '--- seed data'
select pg_temp.ok((select count(*) from journey_categories where owner_id is null and is_default) = 8, '8 shared default categories');
select pg_temp.ok((select count(*) from achievements) = 6, '6 achievements seeded');
select pg_temp.expect_error($$insert into journey_categories (owner_id, name, icon, colour) values (null, 'road trip', 'map', '#FF0000')$$,
  '23505', 'shared default category names are unique regardless of case');

-- ─── 3. Sign-up trigger and profiles ─────────────────────────────────────────
\echo '--- sign-up trigger and profiles'
insert into auth.users (id, email, raw_user_meta_data) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'a@example.test', '{"full_name": "Alice Driver"}'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'b@example.test', '{}'),
  ('cccccccc-0000-0000-0000-000000000003', 'c@example.test', '{"display_name": "Casey"}');

select pg_temp.ok((select count(*) from profiles) = 3 and (select count(*) from user_settings) = 3,
  'sign-up creates a profile and settings row per user');
select pg_temp.ok((select display_name from profiles where id = 'aaaaaaaa-0000-0000-0000-000000000001') = 'Alice Driver'
  and (select display_name from profiles where id = 'bbbbbbbb-0000-0000-0000-000000000002') = 'Driver',
  'display name taken from sign-up metadata, else "Driver"');
select pg_temp.ok((select bool_and(friend_code ~ '^[A-Z0-9]{8}$') and count(distinct friend_code) = 3 from profiles),
  'friend codes generated, well-formed and unique');
select pg_temp.ok((select level from profiles where id = 'aaaaaaaa-0000-0000-0000-000000000001') = 1, 'new users start at level 1');

update profiles set xp = 2500 where id = 'aaaaaaaa-0000-0000-0000-000000000001';
select pg_temp.ok((select level from profiles where id = 'aaaaaaaa-0000-0000-0000-000000000001') = 3, 'level is derived from xp (2,500 XP → level 3)');
select pg_temp.expect_error($$update profiles set level = 10 where id = 'aaaaaaaa-0000-0000-0000-000000000001'$$,
  '428C9', 'level cannot be written directly');
select pg_temp.expect_error($$update profiles set xp = -1 where id = 'aaaaaaaa-0000-0000-0000-000000000001'$$,
  '23514', 'xp cannot go negative');

update profiles set username = 'Speedy' where id = 'aaaaaaaa-0000-0000-0000-000000000001';
select pg_temp.expect_error($$update profiles set username = 'speedy' where id = 'bbbbbbbb-0000-0000-0000-000000000002'$$,
  '23505', 'usernames are unique regardless of case');
select pg_temp.expect_error($$update profiles set username = 'no spaces!' where id = 'bbbbbbbb-0000-0000-0000-000000000002'$$,
  '23514', 'username format enforced');
select pg_temp.expect_error($$update user_settings set unit_system = 'furlongs' where user_id = 'bbbbbbbb-0000-0000-0000-000000000002'$$,
  '23514', 'unit_system values enforced');

-- ─── 4. Vehicles and records ─────────────────────────────────────────────────
\echo '--- vehicles and records'
insert into vehicles (id, owner_id, nickname, make, model, is_active) values
  ('a1000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Mini',  'MINI', 'Cooper', true),
  ('a1000000-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'Golf',  'VW',   'Golf',   false),
  ('b1000000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002', 'Civic', 'Honda','Civic',  true);

select pg_temp.expect_error($$update vehicles set is_active = true where id = 'a1000000-0000-0000-0000-000000000002'$$,
  '23505', 'only one active vehicle per user');
select pg_temp.expect_error($$insert into vehicles (owner_id, nickname, fuel_type) values ('aaaaaaaa-0000-0000-0000-000000000001', 'X', 'steam')$$,
  '23514', 'fuel_type values enforced');
select pg_temp.expect_error($$insert into vehicles (owner_id, nickname, client_ref) values
    ('aaaaaaaa-0000-0000-0000-000000000001', 'P1', 'local-1'), ('aaaaaaaa-0000-0000-0000-000000000001', 'P2', 'local-1')$$,
  '23505', 'client_ref is unique per owner (idempotent offline creates / imports)');
select pg_temp.expect_error($$insert into vehicle_documents (vehicle_id, owner_id, doc_type, storage_path, mime_type, size_bytes)
    values ('b1000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'mot', 'aaaaaaaa-0000-0000-0000-000000000001/y.pdf', 'application/pdf', 100)$$,
  '23503', 'a document cannot be attached to another user''s vehicle');
select pg_temp.expect_error($$insert into vehicle_service_records (vehicle_id, owner_id, record_type, performed_on, title)
    values ('b1000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'service', current_date, 'Oil')$$,
  '23503', 'a service record cannot be attached to another user''s vehicle');

-- ─── 5. Journeys and route points ────────────────────────────────────────────
\echo '--- journeys and route points'
select pg_temp.expect_error($$insert into journeys (owner_id, vehicle_id, started_at) values
    ('aaaaaaaa-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001', now())$$,
  '23503', 'a journey cannot use another user''s vehicle');
select pg_temp.expect_error($$insert into journeys (owner_id, started_at, status) values
    ('aaaaaaaa-0000-0000-0000-000000000001', now(), 'completed')$$,
  '23514', 'a completed journey must have an end time');

insert into journeys (id, owner_id, vehicle_id, started_at, ended_at, status, distance_km) values
  ('a2000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001',
   now() - interval '30 minutes', now(), 'completed', 21.4);

insert into journey_route_points (journey_id, recorded_at, latitude, longitude, speed_kmh) values
  ('a2000000-0000-0000-0000-000000000001', '2026-09-01 10:00:00+00', 54.4609123456, -3.0886123456, 40);
select pg_temp.expect_error($$insert into journey_route_points (journey_id, recorded_at, latitude, longitude)
    values ('a2000000-0000-0000-0000-000000000001', '2026-09-01 10:00:00+00', 54.46, -3.08)$$,
  '23505', 'a re-sent route point is rejected as a duplicate');
insert into journey_route_points (journey_id, recorded_at, latitude, longitude)
  values ('a2000000-0000-0000-0000-000000000001', '2026-09-01 10:00:00+00', 54.46, -3.08) on conflict do nothing;
select pg_temp.ok((select count(*) from journey_route_points) = 1, 'ON CONFLICT DO NOTHING makes re-sent batches harmless');
select pg_temp.ok((select latitude from journey_route_points limit 1) = 54.4609123456, 'coordinates stored at double precision');
select pg_temp.expect_error($$insert into journey_route_points (journey_id, recorded_at, latitude, longitude)
    values ('a2000000-0000-0000-0000-000000000001', now(), 91, 0)$$,
  '23514', 'latitude range enforced');

select pg_temp.expect_error($$insert into journey_routes (journey_id, owner_id)
    values ('a2000000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002')$$,
  '23503', 'a route summary belongs to its journey''s owner');
insert into journey_routes (journey_id, owner_id, route_polyline, point_count)
  values ('a2000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', '_p~iF~ps|U_ulLnnqC', 1);

delete from vehicles where id = 'a1000000-0000-0000-0000-000000000001';
select pg_temp.ok((select vehicle_id is null and owner_id = 'aaaaaaaa-0000-0000-0000-000000000001'
                   from journeys where id = 'a2000000-0000-0000-0000-000000000001'),
  'deleting a vehicle clears journeys.vehicle_id but keeps the owner');

-- ─── 6. Saved locations and Beauty Spots ─────────────────────────────────────
\echo '--- saved locations and Beauty Spots'
select pg_temp.expect_error($$insert into saved_locations (owner_id, kind, name, lat, lng, visibility)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'home', 'Home', 54.0, -3.0, 'public')$$,
  '23514', 'Home can never be public');
select pg_temp.expect_error($$insert into saved_locations (owner_id, kind, name, lat, lng, visibility)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'work', 'Work', 54.0, -3.0, 'friends')$$,
  '23514', 'Work can never be shared with friends');
select pg_temp.expect_error($$insert into saved_locations (owner_id, kind, name, lat, lng, visibility)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'car_park', 'CP', 54.0, -3.0, 'public')$$,
  '23514', 'only Beauty Spots and meeting points can be public');
select pg_temp.expect_error($$insert into saved_locations (owner_id, kind, category, name, lat, lng)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'car_park', 'viewpoint', 'CP', 54.0, -3.0)$$,
  '23514', 'a category is only allowed on Beauty Spots');

insert into saved_locations (id, owner_id, kind, name, lat, lng) values
  ('a3000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'home', 'Home', 54.40, -3.00);
select pg_temp.expect_error($$insert into saved_locations (owner_id, kind, name, lat, lng)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'home', 'Second home', 54.0, -3.0)$$,
  '23505', 'one Home per user');

insert into saved_locations (id, owner_id, kind, category, name, lat, lng, visibility) values
  ('a3000000-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'beauty_spot', 'viewpoint', 'Public view',  54.4609, -3.0886, 'public'),
  ('a3000000-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', 'beauty_spot', 'lake',      'Secret lake',  54.4650, -3.0900, 'private'),
  ('b3000000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002', 'beauty_spot', 'coastal',   'Far away',     50.0000, -5.0000, 'public');

select pg_temp.ok((select geog is not null from saved_locations where id = 'a3000000-0000-0000-0000-000000000002'),
  'geography column generated from lat/lng');
select pg_temp.ok(
  (select array_agg(name order by distance_m) from public.nearby_spots(54.4600, -3.0880, 10000)) = array['Public view'],
  'nearby_spots with no signed-in user: public spots within radius only');

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}', false);
select pg_temp.ok(
  (select array_agg(name order by distance_m) from public.nearby_spots(54.4600, -3.0880, 10000)) = array['Public view', 'Secret lake'],
  'nearby_spots as the owner: own private spots included, nearest first');
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-0000-0000-000000000002","role":"authenticated"}', false);
select pg_temp.ok(
  (select array_agg(name order by distance_m) from public.nearby_spots(54.4600, -3.0880, 10000)) = array['Public view'],
  'nearby_spots as another user: someone else''s private spot excluded');
select pg_temp.ok(
  (select count(*) from public.spots_in_view(54.0, -3.5, 55.0, -2.5)) = 1,
  'spots_in_view returns public spots inside the map viewport only');
select set_config('request.jwt.claims', '', false);

-- ─── 7. Photos and the Storage deletion queue ────────────────────────────────
\echo '--- photos and Storage deletion queue'
insert into vehicles (id, owner_id, nickname) values
  ('a1000000-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', 'Track car');

select pg_temp.expect_error($$insert into photos (owner_id, vehicle_id, journey_id, bucket, storage_path, mime_type, size_bytes)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000003', 'a2000000-0000-0000-0000-000000000001',
            'vehicle-photos', 'aaaaaaaa-0000-0000-0000-000000000001/p1.jpg', 'image/jpeg', 10)$$,
  '23514', 'a photo has exactly one parent');
select pg_temp.expect_error($$insert into photos (owner_id, vehicle_id, bucket, storage_path, mime_type, size_bytes)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000003', 'journey-photos', 'aaaaaaaa-0000-0000-0000-000000000001/p2.jpg', 'image/jpeg', 10)$$,
  '23514', 'a photo''s bucket must match its parent');
select pg_temp.expect_error($$insert into photos (owner_id, vehicle_id, bucket, storage_path, mime_type, size_bytes)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001', 'vehicle-photos', 'aaaaaaaa-0000-0000-0000-000000000001/p3.jpg', 'image/jpeg', 10)$$,
  '23503', 'a photo cannot be attached to another user''s vehicle');
select pg_temp.expect_error($$insert into photos (owner_id, vehicle_id, bucket, storage_path, mime_type, size_bytes)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000003', 'vehicle-photos', 'aaaaaaaa-0000-0000-0000-000000000001/p4.jpg', 'image/jpeg', 6000000)$$,
  '23514', 'photo size limit enforced');

select pg_temp.expect_error($$insert into photos (owner_id, vehicle_id, bucket, storage_path, mime_type, size_bytes)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000003', 'vehicle-photos',
            'bbbbbbbb-0000-0000-0000-000000000002/stolen.jpg', 'image/jpeg', 10)$$,
  '23514', 'a photo row cannot point at a file in another user''s folder');
select pg_temp.expect_error($$insert into vehicle_documents (vehicle_id, owner_id, doc_type, storage_path, mime_type, size_bytes)
    values ('a1000000-0000-0000-0000-000000000003', 'aaaaaaaa-0000-0000-0000-000000000001', 'v5c',
            'bbbbbbbb-0000-0000-0000-000000000002/v5c.pdf', 'application/pdf', 10)$$,
  '23514', 'a document row cannot point at a file in another user''s folder');

insert into photos (id, owner_id, vehicle_id, bucket, storage_path, thumb_path, mime_type, size_bytes, status) values
  ('a4000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000003',
   'vehicle-photos', 'aaaaaaaa-0000-0000-0000-000000000001/a1/p1.jpg', 'aaaaaaaa-0000-0000-0000-000000000001/a1/p1_thumb.jpg', 'image/jpeg', 1000, 'ready'),
  ('a4000000-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000003',
   'vehicle-photos', 'aaaaaaaa-0000-0000-0000-000000000001/a1/p2.jpg', null, 'image/jpeg', 1000, 'ready');
update vehicles set cover_photo_id = 'a4000000-0000-0000-0000-000000000002' where id = 'a1000000-0000-0000-0000-000000000003';

delete from photos where id = 'a4000000-0000-0000-0000-000000000001';
select pg_temp.ok(
  (select count(*) from private.storage_delete_queue where bucket = 'vehicle-photos') = 2,
  'deleting a photo queues the image and its thumbnail for Storage deletion');

delete from vehicles where id = 'a1000000-0000-0000-0000-000000000003';
select pg_temp.ok(
  (select count(*) from private.storage_delete_queue where bucket = 'vehicle-photos') = 3
  and not exists (select 1 from photos where vehicle_id = 'a1000000-0000-0000-0000-000000000003'),
  'deleting a vehicle cascades to its photos and queues their files');

update profiles set avatar_path = 'aaaaaaaa-0000-0000-0000-000000000001/av1.jpg' where id = 'aaaaaaaa-0000-0000-0000-000000000001';
update profiles set avatar_path = 'aaaaaaaa-0000-0000-0000-000000000001/av2.jpg' where id = 'aaaaaaaa-0000-0000-0000-000000000001';
select pg_temp.ok(
  (select array_agg(path) from private.storage_delete_queue where bucket = 'avatars') = array['aaaaaaaa-0000-0000-0000-000000000001/av1.jpg'],
  'replacing an avatar queues the old file only');

-- ─── 8. Friends ──────────────────────────────────────────────────────────────
\echo '--- friends'
insert into friend_requests (from_user_id, to_user_id) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002');
select pg_temp.expect_error($$insert into friend_requests (from_user_id, to_user_id)
    values ('bbbbbbbb-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001')$$,
  '23505', 'only one pending request per pair, in either direction');
select pg_temp.expect_error($$insert into friend_requests (from_user_id, to_user_id)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001')$$,
  '23514', 'no friend requests to yourself');
select pg_temp.expect_error($$update friend_requests set status = 'accepted'$$,
  '23514', 'a responded request must record responded_at');
select pg_temp.expect_error($$insert into friendships (user_id, friend_id)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001')$$,
  '23514', 'no self-friendship');

-- ─── 9. Community ────────────────────────────────────────────────────────────
\echo '--- community'
insert into groups (id, owner_id, name) values ('a5000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Minis');
insert into group_members (group_id, user_id, role) values ('a5000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'owner');
select pg_temp.expect_error($$insert into group_members (group_id, user_id, role)
    values ('a5000000-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002', 'owner')$$,
  '23505', 'a group has exactly one owner');
select pg_temp.expect_error($$insert into group_members (group_id, user_id, role, status)
    values ('a5000000-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-000000000003', 'member', 'banned')$$,
  '23514', 'membership status values enforced');
select pg_temp.expect_error($$insert into events (organiser_id, name, starts_at, visibility)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'Meet', now(), 'group')$$,
  '23514', 'a group-only event needs a group');
select pg_temp.expect_error($$insert into events (organiser_id, name, starts_at, ends_at)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'Meet', now(), now() - interval '1 hour')$$,
  '23514', 'an event cannot end before it starts');
select pg_temp.expect_error($$insert into convoys (owner_id, name, starts_at, max_participants)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'Run', now(), 1)$$,
  '23514', 'a convoy allows at least 2 participants');

insert into convoys (id, owner_id, name, starts_at) values
  ('a6000000-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Lakes run', now());
update journeys set convoy_id = 'a6000000-0000-0000-0000-000000000001' where id = 'a2000000-0000-0000-0000-000000000001';
select pg_temp.expect_error($$update journeys set convoy_id = '00000000-0000-0000-0000-00000000dead' where id = 'a2000000-0000-0000-0000-000000000001'$$,
  '23503', 'journeys.convoy_id must reference a real convoy');
delete from convoys where id = 'a6000000-0000-0000-0000-000000000001';
select pg_temp.ok((select convoy_id is null from journeys where id = 'a2000000-0000-0000-0000-000000000001'),
  'deleting a convoy clears journeys.convoy_id');

select pg_temp.expect_error($$insert into private.join_codes (code, group_id, convoy_id)
    values ('ABC123', 'a5000000-0000-0000-0000-000000000001', null), ('ABC123', 'a5000000-0000-0000-0000-000000000001', null)$$,
  '23505', 'join codes are unique');
select pg_temp.expect_error($$insert into private.join_codes (code) values ('XYZ789')$$,
  '23514', 'a join code belongs to exactly one group or convoy');

-- ─── 10. Notifications ───────────────────────────────────────────────────────
\echo '--- notifications'
select pg_temp.expect_error($$insert into notifications (user_id, type, title)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'made_up', 'x')$$,
  '23514', 'notification types enforced');
insert into notifications (user_id, type, title) values ('aaaaaaaa-0000-0000-0000-000000000001', 'system', 'Welcome');
update notifications set read_at = now();
select pg_temp.ok((select bool_and(is_read) from notifications), 'is_read derived from read_at');

-- ─── 11. Account deletion cascade ────────────────────────────────────────────
\echo '--- account deletion'
insert into content_reports (reporter_id, target_type, target_id, reason) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'location', 'b3000000-0000-0000-0000-000000000001', 'spam');
delete from auth.users where id = 'aaaaaaaa-0000-0000-0000-000000000001';
select pg_temp.ok(
  not exists (select 1 from profiles        where id       = 'aaaaaaaa-0000-0000-0000-000000000001')
  and not exists (select 1 from vehicles    where owner_id = 'aaaaaaaa-0000-0000-0000-000000000001')
  and not exists (select 1 from journeys    where owner_id = 'aaaaaaaa-0000-0000-0000-000000000001')
  and not exists (select 1 from journey_route_points)
  and not exists (select 1 from journey_routes)
  and not exists (select 1 from saved_locations where owner_id = 'aaaaaaaa-0000-0000-0000-000000000001')
  and not exists (select 1 from friend_requests)
  and not exists (select 1 from groups      where owner_id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  'deleting the auth user removes all of their data');
select pg_temp.ok(
  (select reporter_id is null from content_reports limit 1),
  'content reports survive the reporter''s deletion (reporter cleared)');
select pg_temp.ok(
  exists (select 1 from private.storage_delete_queue where bucket = 'avatars' and path like '%av2.jpg'),
  'deleting an account queues its avatar for Storage deletion');

\echo '=== ALL SCHEMA SMOKE TESTS PASSED ==='
