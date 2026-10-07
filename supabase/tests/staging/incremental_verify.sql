-- ============================================================================
-- Verification after an INCREMENTAL staging deployment.
--
-- The schema smoke and RLS suites (tests/local/10_*, 20_*) assume an empty
-- database: they assert exact row counts over their own fixtures, so they can
-- only run on a first deployment. They still run in full against a
-- throwaway database built from every migration on each change (database.yml).
-- This file is what runs on staging once it holds real data:
--   1. data-independent structure and exposure checks over the whole schema
--      (the same rules the smoke suite asserts);
--   2. the presence status rules (migration 0016);
--   3. presence visibility, as real `authenticated` / `anon` sessions, with
--      temporary fixture users (@example.test) that no other row refers to;
--   4. the Realtime inbox (0017);
--   5. private live location (0018): who may read a position, and who is
--      sent it, with the same fixture users and a temporary Convoy.
-- The workflow runs it INSIDE A TRANSACTION THAT IS ALWAYS ROLLED BACK, and
-- then confirms nothing was left behind. Never run it any other way against a
-- hosted project.
-- ============================================================================
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null
set client_min_messages = notice;

create function pg_temp.ok(p_condition boolean, p_label text)
returns void language plpgsql as $$
begin
  if p_condition is distinct from true then raise exception 'FAIL: %', p_label; end if;
  raise notice 'ok   %', p_label;
end;
$$;

-- ─── 1. Structure and exposure (whole schema, any data) ──────────────────────
\echo '--- structure and exposure'
select pg_temp.ok(
  not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity),
  'RLS is enabled on every public table');
select pg_temp.ok(
  not exists (select 1 from pg_tables t
              where t.schemaname = 'public'
                and not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = t.tablename)),
  'every public table has at least one policy');
select pg_temp.ok(
  not exists (
    select 1 from pg_tables t, unnest(array['anon','authenticated']) r(role)
    where t.schemaname = 'public'
      and has_table_privilege(r.role, format('public.%I', t.tablename), 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')),
  'anon and authenticated hold no privileges on any public table');
select pg_temp.ok(
  not has_function_privilege('anon', 'private.can_see_presence(uuid)', 'EXECUTE')
  and has_function_privilege('authenticated', 'private.can_see_presence(uuid)', 'EXECUTE'),
  'only signed-in users may evaluate presence visibility');

\echo '--- presence schema (0016)'
select pg_temp.ok(
  (select array_agg(column_name::text order by ordinal_position) from information_schema.columns
    where table_schema = 'public' and table_name = 'user_presence')
  = array['user_id','app_state','driving','journey_id','last_seen_at','updated_at'],
  'user_presence has the expected columns');
select pg_temp.ok(
  (select column_default = 'true' and is_nullable = 'NO' from information_schema.columns
    where table_schema = 'public' and table_name = 'user_settings' and column_name = 'show_activity_status'),
  'show_activity_status exists, not null, default on');
select pg_temp.ok(
  exists (select 1 from pg_trigger where tgname = 'journeys_clear_presence' and tgrelid = 'public.journeys'::regclass),
  'finishing a journey clears driving (trigger present)');

-- ─── 2. Status rules ─────────────────────────────────────────────────────────
\echo '--- presence status rules'
select pg_temp.ok(private.presence_status('foreground', false, now() - interval '30 seconds') = 'online',  'recent heartbeat: online');
select pg_temp.ok(private.presence_status('background', false, now() - interval '5 seconds')  = 'away',    'backgrounded: away');
select pg_temp.ok(private.presence_status('foreground', false, now() - interval '5 minutes')  = 'away',    '2–10 minutes: away');
select pg_temp.ok(private.presence_status('foreground', false, now() - interval '11 minutes') = 'offline', 'stale heartbeat: offline');
select pg_temp.ok(private.presence_status('background', true,  now() - interval '90 seconds') = 'driving', 'recent drive: driving');
select pg_temp.ok(private.presence_status('foreground', true,  now() - interval '2 hours')    = 'offline', 'stale drive does not stay driving');
select pg_temp.ok(private.presence_status('signed_out', false, now()) = 'offline',                         'signed out: offline');

-- ─── 3. Visibility, as real client sessions ──────────────────────────────────
-- owner o, friend f, stranger s, blocked b (with a stray friendship row), all
-- temporary. Table privileges are granted to authenticated only inside this
-- rolled-back transaction (the worst case for future direct access).
\echo '--- presence visibility'
create function pg_temp.id(p text) returns uuid language sql immutable as $$
  select case p when 'o' then 'f1e5e0c0-0000-4000-8000-0000000000a1' when 'f' then 'f1e5e0c0-0000-4000-8000-0000000000a2'
                when 's' then 'f1e5e0c0-0000-4000-8000-0000000000a3' when 'b' then 'f1e5e0c0-0000-4000-8000-0000000000a4' end::uuid
$$;
create function pg_temp.seen_by(p_who text) returns text[] language plpgsql as $$
declare
  v    text[];
  me   uuid   := pg_temp.id(p_who);
  mine uuid[] := array[pg_temp.id('o'), pg_temp.id('f'), pg_temp.id('s'), pg_temp.id('b')];
begin
  perform set_config('request.jwt.claims', json_build_object('sub', me, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  select coalesce(array_agg(user_id::text order by user_id), '{}') into v from public.user_presence
   where user_id = any (mine);
  reset role; perform set_config('request.jwt.claims', '', true);
  return v;
end;
$$;
create function pg_temp.ids(variadic p text[]) returns text[] language sql immutable as $$
  select array_agg(pg_temp.id(x)::text order by pg_temp.id(x)) from unnest(p) x
$$;

insert into auth.users (id, email, raw_user_meta_data) values
  (pg_temp.id('o'), 'presence-o@example.test', '{"display_name":"Presence O"}'),
  (pg_temp.id('f'), 'presence-f@example.test', '{"display_name":"Presence F"}'),
  (pg_temp.id('s'), 'presence-s@example.test', '{"display_name":"Presence S"}'),
  (pg_temp.id('b'), 'presence-b@example.test', '{"display_name":"Presence B"}');
insert into public.friendships (user_id, friend_id) values
  (pg_temp.id('o'), pg_temp.id('f')), (pg_temp.id('f'), pg_temp.id('o')),
  (pg_temp.id('o'), pg_temp.id('b')), (pg_temp.id('b'), pg_temp.id('o'));
insert into public.user_blocks (blocker_id, blocked_id) values (pg_temp.id('o'), pg_temp.id('b'));
insert into public.user_presence (user_id, app_state) values
  (pg_temp.id('o'), 'foreground'), (pg_temp.id('f'), 'foreground'), (pg_temp.id('s'), 'foreground'), (pg_temp.id('b'), 'foreground');
grant select, insert, update, delete on public.user_presence to authenticated;

select pg_temp.ok(pg_temp.seen_by('o') = pg_temp.ids('o', 'f'), 'owner sees their own presence and their friend''s');
select pg_temp.ok(pg_temp.seen_by('f') = pg_temp.ids('o', 'f'), 'a friend sees presence when permitted');
select pg_temp.ok(pg_temp.seen_by('s') = pg_temp.ids('s'), 'a stranger sees no one else''s presence');
select pg_temp.ok(pg_temp.seen_by('b') = pg_temp.ids('b'), 'a blocked user sees nothing, even with a friendship row');
update public.user_settings set show_activity_status = false where user_id = pg_temp.id('o');
select pg_temp.ok(pg_temp.seen_by('f') = pg_temp.ids('f'), 'activity status off hides it from friends');
select pg_temp.ok(pg_temp.seen_by('o') @> pg_temp.ids('o'), 'the owner still sees their own with it off');

do $$
declare
  n  bigint;
  me uuid := pg_temp.id('o');
begin
  perform set_config('request.jwt.claims', json_build_object('sub', me, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  update public.user_presence set last_seen_at = now() + interval '1 year' where user_id = me;
  get diagnostics n = row_count;
  reset role; perform set_config('request.jwt.claims', '', true);
  if n <> 0 then raise exception 'FAIL: a client changed its own presence row'; end if;
  raise notice 'ok   clients cannot write presence, even their own';
end;
$$;
do $$
declare
  owner uuid := pg_temp.id('o');
begin
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('role', 'anon', true);
  begin
    perform private.can_see_presence(owner);
    reset role; perform set_config('request.jwt.claims', '', true);
    raise exception 'FAIL: an anonymous caller could evaluate presence';
  exception when insufficient_privilege then
    reset role; perform set_config('request.jwt.claims', '', true);
  end;
  raise notice 'ok   anonymous callers cannot ask';
end;
$$;

-- ─── 4. Realtime inbox (0017) ────────────────────────────────────────────────
\echo '--- realtime presence inbox'
select pg_temp.ok(
  exists (select 1 from pg_policies where schemaname = 'realtime' and tablename = 'messages' and policyname = 'driveos_inbox_receive'),
  'the inbox policy exists on realtime.messages');
select pg_temp.ok(
  not exists (select 1 from pg_policies where schemaname = 'realtime' and tablename = 'messages'
               and policyname like 'driveos%' and cmd in ('INSERT', 'ALL', 'UPDATE', 'DELETE')),
  'no DriveOS policy lets a client publish');

-- realtime.messages is partitioned by day, and Realtime creates the
-- partitions itself once a client has connected to the project. Until then
-- realtime.send() can't store a message (it warns rather than fails, so
-- presence writes still succeed, but nothing is delivered). Said plainly
-- rather than as a partition error further down.
create function pg_temp.realtime_partition_ready() returns boolean language plpgsql as $$
begin
  begin
    insert into realtime.messages (topic, extension, payload, event, private)
      values ('inbox:f1e5e0c0-0000-4000-8000-0000000000a0', 'broadcast', '{"probe":true}', 'probe', true);
  exception when others then
    return false;
  end;
  return true;
end;
$$;
select pg_temp.ok(pg_temp.realtime_partition_ready(),
  'Realtime has created today''s realtime.messages partition (it does once a client connects; until then broadcasts are not delivered)');

-- Realtime authorises a join by selecting from realtime.messages as the user
-- with realtime.topic() set to the channel; a probe row makes the answer visible.
create function pg_temp.can_join(p_who text, p_topic text) returns boolean language plpgsql as $$
declare
  n  bigint;
  me uuid := pg_temp.id(p_who);
begin
  insert into realtime.messages (topic, extension, payload, event, private) values (p_topic, 'broadcast', '{"probe":true}', 'probe', true);
  perform set_config('request.jwt.claims', json_build_object('sub', me, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  perform set_config('realtime.topic', p_topic, true);
  begin
    select count(*) into n from realtime.messages where topic = p_topic;
  exception when insufficient_privilege then n := 0;
  end;
  reset role; perform set_config('request.jwt.claims', '', true); perform set_config('realtime.topic', '', true);
  return n > 0;
end;
$$;
select pg_temp.ok(pg_temp.can_join('o', 'inbox:' || pg_temp.id('o')), 'a user can join their own inbox');
select pg_temp.ok(not pg_temp.can_join('f', 'inbox:' || pg_temp.id('o')), 'a friend cannot join someone else''s inbox');
select pg_temp.ok(not pg_temp.can_join('s', 'inbox:' || pg_temp.id('o')), 'a stranger cannot join someone else''s inbox');
do $$
declare
  me     uuid := pg_temp.id('o');
  target text := 'inbox:' || pg_temp.id('f');
begin
  perform set_config('request.jwt.claims', json_build_object('sub', me, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  begin
    insert into realtime.messages (topic, extension, payload, event, private) values (target, 'broadcast', '{}', 'presence', true);
    reset role; perform set_config('request.jwt.claims', '', true);
    raise exception 'FAIL: a client published into someone else''s inbox';
  exception when insufficient_privilege then
    reset role; perform set_config('request.jwt.claims', '', true);
  end;
  raise notice 'ok   a client cannot publish into an inbox';
end;
$$;

-- Fan-out: o's presence reaches friend f (app open), never stranger s or blocked b
-- Messages for the fixture inboxes published after the last mark_seen().
create temp table seen_messages (id uuid primary key);
create function pg_temp.mark_seen() returns void language sql as $$
  insert into seen_messages select id from realtime.messages
   where topic like 'inbox:f1e5e0c0-0000-4000-8000-0000000000a%' on conflict do nothing
$$;
create function pg_temp.inbox(p text) returns text[] language sql as $$
  select coalesce(array_agg((payload->>'type') || ':' || coalesce(payload->>'status', '-') order by inserted_at, id), '{}')
    from realtime.messages m where topic = 'inbox:' || pg_temp.id(p) and event = 'presence'
     and not exists (select 1 from seen_messages s where s.id = m.id)
$$;
update public.user_settings set show_activity_status = true where user_id = pg_temp.id('o');
update public.user_presence set app_state = 'foreground', driving = false, last_seen_at = now()
 where user_id in (pg_temp.id('f'), pg_temp.id('s'), pg_temp.id('b'));
select pg_temp.mark_seen();
update public.user_presence set driving = true, last_seen_at = now() where user_id = pg_temp.id('o');
select pg_temp.ok(pg_temp.inbox('f') = array['presence:driving'], 'a friend with the app open receives Driving');
select pg_temp.ok(pg_temp.inbox('s') = '{}', 'a stranger receives nothing');
select pg_temp.ok(pg_temp.inbox('b') = '{}', 'a blocked user receives nothing');
update public.user_settings set show_activity_status = false where user_id = pg_temp.id('o');
-- Both messages are in this one transaction, so they share inserted_at and
-- their order is not defined: compare them as a set.
select pg_temp.ok((select array_agg(x order by x) from unnest(pg_temp.inbox('f')) x) = array['hidden:-', 'presence:driving'],
  'hiding activity tells friends at once');

-- ─── 5. Private live location (0018) ─────────────────────────────────────────
\echo '--- live location schema (0018)'
select pg_temp.ok(
  (select array_agg(column_name::text order by ordinal_position) from information_schema.columns
    where table_schema = 'public' and table_name = 'live_locations')
  = array['user_id','latitude','longitude','heading_deg','speed_kmh','accuracy_m','driving','recorded_at','expires_at'],
  'live_locations has the expected columns (one current row per user, no history)');
select pg_temp.ok(
  (select column_default = '''off''::text' and is_nullable = 'NO' from information_schema.columns
    where table_schema = 'public' and table_name = 'user_settings' and column_name = 'location_sharing'),
  'location_sharing exists, not null, default off');
select pg_temp.ok(
  (select column_default = '''none''::text' and is_nullable = 'NO' from information_schema.columns
    where table_schema = 'public' and table_name = 'user_settings' and column_name = 'location_friend_audience'),
  'location_friend_audience exists, not null, default none (nobody)');
select pg_temp.ok(
  (select array_agg(policyname::text order by policyname) from pg_policies
    where schemaname = 'public' and tablename in ('live_locations', 'location_share_friends', 'location_share_convoys'))
  = array['live_locations_select', 'location_share_convoys_select_own', 'location_share_friends_select_own']
  and not exists (select 1 from pg_policies where schemaname = 'public'
                   and tablename in ('live_locations', 'location_share_friends', 'location_share_convoys') and cmd <> 'SELECT'),
  'live location tables are read-only to clients (no write policies)');
select pg_temp.ok(
  not has_function_privilege('anon', 'private.can_see_live_location_as_me(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.can_see_live_location(uuid, uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.live_location_granted(uuid, uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.publish_live_location(uuid)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'private.revoke_live_location(uuid, uuid[])', 'EXECUTE'),
  'clients cannot ask about other people''s sharing, evaluate it anonymously, or trigger a fan-out');
select pg_temp.ok(
  (select count(*) from pg_trigger where not tgisinternal and tgname in (
     'live_locations_publish', 'user_settings_live_location', 'location_share_friends_publish', 'location_share_convoys_publish',
     'convoy_participants_live_location', 'convoys_live_location', 'friendships_live_location', 'user_blocks_live_location',
     'user_presence_live_location', 'convoys_live_location_delete', 'profiles_live_location_delete')) = 11,
  'every revocation trigger is installed');

\echo '--- live location visibility and fan-out'
-- A Convoy member k, and a temporary private Convoy (o leads, k is in it).
insert into auth.users (id, email, raw_user_meta_data) values
  ('f1e5e0c0-0000-4000-8000-0000000000a5', 'presence-k@example.test', '{"display_name":"Presence K"}');
insert into public.user_presence (user_id, app_state) values ('f1e5e0c0-0000-4000-8000-0000000000a5', 'foreground');
insert into public.convoys (id, owner_id, name, visibility, starts_at) values
  ('f1e5e0c0-0000-4000-8000-0000000000c1', pg_temp.id('o'), 'Verification Convoy', 'private', now() + interval '1 hour');
insert into public.convoy_participants (convoy_id, user_id, role) values
  ('f1e5e0c0-0000-4000-8000-0000000000c1', pg_temp.id('o'), 'leader'),
  ('f1e5e0c0-0000-4000-8000-0000000000c1', 'f1e5e0c0-0000-4000-8000-0000000000a5', 'member');
grant select on public.live_locations to authenticated;

create function pg_temp.live_seen_by(p_who uuid) returns boolean language plpgsql as $$
declare
  n bigint;
  owner uuid := pg_temp.id('o');
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_who, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  select count(*) into n from public.live_locations where user_id = owner;
  reset role; perform set_config('request.jwt.claims', '', true);
  return n > 0;
end;
$$;
create function pg_temp.live_inbox(p_who uuid) returns text[] language sql as $$
  select coalesce(array_agg(distinct payload->>'type'), '{}') from realtime.messages m
   where topic = 'inbox:' || p_who and event = 'live_location'
     and not exists (select 1 from seen_messages s where s.id = m.id)
$$;
create function pg_temp.k() returns uuid language sql immutable as $$ select 'f1e5e0c0-0000-4000-8000-0000000000a5'::uuid $$;

-- b is blocked by o (section 3); f is a friend; s a stranger; k only shares a Convoy.
update public.user_presence set app_state = 'foreground', last_seen_at = now()
 where user_id in (pg_temp.id('f'), pg_temp.id('s'), pg_temp.id('b'), pg_temp.k());
update public.user_presence set app_state = 'foreground', driving = true, last_seen_at = now() where user_id = pg_temp.id('o');
insert into public.live_locations (user_id, latitude, longitude, driving, expires_at)
  values (pg_temp.id('o'), 0, 0, true, now() + interval '3 minutes');
select pg_temp.ok(not pg_temp.live_seen_by(pg_temp.id('f')), 'with sharing off (the default) a friend sees nothing');
delete from public.live_locations where user_id = pg_temp.id('o');

select pg_temp.mark_seen();
update public.user_settings set location_sharing = 'while_driving', location_friend_audience = 'selected' where user_id = pg_temp.id('o');
insert into public.location_share_friends (owner_id, friend_id) values (pg_temp.id('o'), pg_temp.id('f'));
insert into public.live_locations (user_id, latitude, longitude, driving, expires_at)
  values (pg_temp.id('o'), 0, 0, true, now() + interval '3 minutes');
select pg_temp.ok(pg_temp.live_seen_by(pg_temp.id('o')), 'the owner sees their own position');
select pg_temp.ok(pg_temp.live_seen_by(pg_temp.id('f')), 'a selected friend sees it');
select pg_temp.ok(not pg_temp.live_seen_by(pg_temp.id('s')), 'a stranger does not');
select pg_temp.ok(not pg_temp.live_seen_by(pg_temp.id('b')), 'a blocked user does not, even with a friendship row');
select pg_temp.ok(not pg_temp.live_seen_by(pg_temp.k()), 'a Convoy member does not, until the Convoy is turned on');
select pg_temp.ok(pg_temp.live_inbox(pg_temp.id('f')) = array['live_location'], 'the selected friend receives it live');
select pg_temp.ok(pg_temp.live_inbox(pg_temp.id('s')) = '{}' and pg_temp.live_inbox(pg_temp.id('b')) = '{}'
                  and pg_temp.live_inbox(pg_temp.k()) = '{}', 'nobody else receives it');

select pg_temp.mark_seen();
insert into public.location_share_convoys (owner_id, convoy_id) values (pg_temp.id('o'), 'f1e5e0c0-0000-4000-8000-0000000000c1');
select pg_temp.ok(pg_temp.live_seen_by(pg_temp.k()), 'turning the Convoy on shares with its members');
select pg_temp.ok(pg_temp.live_inbox(pg_temp.k()) = array['live_location'], 'who receive it live');
select pg_temp.mark_seen();
delete from public.convoy_participants where convoy_id = 'f1e5e0c0-0000-4000-8000-0000000000c1' and user_id = pg_temp.k();
select pg_temp.ok(not pg_temp.live_seen_by(pg_temp.k()), 'leaving the Convoy ends it');
select pg_temp.ok(pg_temp.live_inbox(pg_temp.k()) = array['live_location_hidden'], 'and the ex-member is told to remove it');

select pg_temp.mark_seen();
delete from public.location_share_friends where owner_id = pg_temp.id('o') and friend_id = pg_temp.id('f');
select pg_temp.ok(not pg_temp.live_seen_by(pg_temp.id('f')), 'removing a selected friend ends it');
select pg_temp.ok(pg_temp.live_inbox(pg_temp.id('f')) = array['live_location_hidden'], 'and they are told to remove it');

update public.user_settings set location_friend_audience = 'all' where user_id = pg_temp.id('o');
update public.live_locations set recorded_at = now() - interval '5 minutes', expires_at = now() - interval '1 second' where user_id = pg_temp.id('o');
select pg_temp.ok(not pg_temp.live_seen_by(pg_temp.id('f')) and not pg_temp.live_seen_by(pg_temp.id('o')),
  'an expired position is unreadable, even before clean-up');
select pg_temp.mark_seen();
update public.live_locations set recorded_at = now(), expires_at = now() + interval '3 minutes' where user_id = pg_temp.id('o');
update public.user_settings set location_sharing = 'off' where user_id = pg_temp.id('o');
select pg_temp.ok(not exists (select 1 from public.live_locations where user_id = pg_temp.id('o')), 'turning sharing off deletes the position');
select pg_temp.ok('live_location_hidden' = any (pg_temp.live_inbox(pg_temp.id('f'))), 'and viewers are told to remove it');

\echo '--- live location strict WHEN (0019)'
update public.user_settings set location_sharing = 'while_using', location_friend_audience = 'all' where user_id = pg_temp.id('o');
update public.user_presence set app_state = 'foreground', driving = true, last_seen_at = now() where user_id = pg_temp.id('o');
insert into public.live_locations (user_id, latitude, longitude, driving, expires_at)
  values (pg_temp.id('o'), 0, 0, true, now() + interval '3 minutes');
select pg_temp.ok(pg_temp.live_seen_by(pg_temp.id('f')), 'while using, on screen during a drive: shared');
select pg_temp.mark_seen();
update public.user_presence set app_state = 'background' where user_id = pg_temp.id('o');
select pg_temp.ok(not pg_temp.live_seen_by(pg_temp.id('f')), 'while using, backgrounded mid-drive: hidden at once');
select pg_temp.ok('live_location_hidden' = any (pg_temp.live_inbox(pg_temp.id('f'))), 'and viewers are told');
update public.user_settings set location_sharing = 'while_driving' where user_id = pg_temp.id('o');
insert into public.live_locations (user_id, latitude, longitude, driving, expires_at)
  values (pg_temp.id('o'), 0, 0, true, now() + interval '3 minutes');
select pg_temp.ok(pg_temp.live_seen_by(pg_temp.id('f')), 'while driving, backgrounded during a drive: still shared');
update public.user_presence set driving = false where user_id = pg_temp.id('o');
select pg_temp.ok(not pg_temp.live_seen_by(pg_temp.id('f')), 'while driving, the drive ends: hidden');

\echo '=== ALL INCREMENTAL VERIFICATION CHECKS PASSED ==='
