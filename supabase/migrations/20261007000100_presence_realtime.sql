-- ============================================================================
-- 0017 · Realtime presence: live updates to friends' inboxes
--
-- Every signed-in user listens on ONE private Realtime channel,
-- `inbox:<their user id>`. The database decides who receives what:
--   * presence changes (0016) are broadcast to the owner's friends who may
--     see them (private.can_see_presence's rules: genuine friends, no block
--     either way, the owner's activity status on), and only to those with
--     the app open right now (their own presence is foreground and recent);
--   * turning activity status off sends "hidden" to every friend at once;
--   * a friendship ending (unfriend, block, account deletion) sends
--     "unfriended" to the person who lost it.
-- Clients never choose recipients and can't publish: realtime.messages gets
-- a read policy for your own inbox only, and no insert policy.
-- Broadcasts go through realtime.send(), so they are delivered only if the
-- transaction that caused them commits.
--
-- Payloads carry only what the friend list shows: the user id, the derived
-- status and the last-active time (or the event type alone).
-- ============================================================================

do $$
begin
  if to_regclass('realtime.messages') is null or to_regprocedure('realtime.send(jsonb, text, text, boolean)') is null then
    raise exception 'Supabase Realtime (realtime.messages, realtime.send) is not available on this database';
  end if;
end;
$$;

-- ─── Who may receive: your own inbox only ────────────────────────────────────
-- Realtime evaluates this with realtime.topic() set to the channel being
-- joined. Broadcast only (no Realtime Presence on these channels); with no
-- insert policy, nobody can send on them from a client.
create policy driveos_inbox_receive on realtime.messages
  for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and (select realtime.topic()) = 'inbox:' || (select auth.uid())::text
  );

-- ─── Fan-out ─────────────────────────────────────────────────────────────────
create function private.inbox_send(p_recipient uuid, p_payload jsonb)
returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  perform realtime.send(p_payload, 'presence', 'inbox:' || p_recipient::text, true);
end;
$$;

-- The owner's presence as their friends see it, to every friend allowed to
-- see it who has the app open (anyone else gets a fresh snapshot when they
-- open it).
create function private.publish_presence(p_owner uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  p       public.user_presence;
  payload jsonb;
  viewer  uuid;
begin
  select * into p from public.user_presence where user_id = p_owner;
  if not found then return; end if;
  if not coalesce((select s.show_activity_status from public.user_settings s where s.user_id = p_owner), false) then
    return;
  end if;
  payload := jsonb_build_object(
    'type', 'presence',
    'userId', p_owner,
    'status', private.presence_status(p.app_state, p.driving, p.last_seen_at),
    'lastSeenAt', to_char(p.last_seen_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  for viewer in
    select f.friend_id
      from public.friendships f
      join public.user_presence vp on vp.user_id = f.friend_id
     where f.user_id = p_owner
       and not private.is_blocked_between(p_owner, f.friend_id)
       and vp.app_state = 'foreground'
       and vp.last_seen_at > now() - interval '3 minutes'
  loop
    perform private.inbox_send(viewer, payload);
  end loop;
end;
$$;

-- Activity status turned off: every friend drops it at once (whether or not
-- they have the app open, so no stale status survives in a cache).
create function private.publish_presence_hidden(p_owner uuid)
returns void
language plpgsql security definer
set search_path = ''
as $$
declare
  viewer uuid;
begin
  for viewer in select f.friend_id from public.friendships f where f.user_id = p_owner loop
    perform private.inbox_send(viewer, jsonb_build_object('type', 'hidden', 'userId', p_owner));
  end loop;
end;
$$;

revoke execute on function
  private.inbox_send(uuid, jsonb), private.publish_presence(uuid), private.publish_presence_hidden(uuid)
from public, anon, authenticated;

-- ─── Triggers ────────────────────────────────────────────────────────────────
create function private.on_presence_change()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  perform private.publish_presence(new.user_id);
  return null;
end;
$$;

create trigger user_presence_publish
  after insert or update on public.user_presence
  for each row execute function private.on_presence_change();

create function private.on_activity_visibility_change()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  if new.show_activity_status then
    perform private.publish_presence(new.user_id);
  else
    perform private.publish_presence_hidden(new.user_id);
  end if;
  return null;
end;
$$;

create trigger user_settings_publish_visibility
  after update of show_activity_status on public.user_settings
  for each row when (old.show_activity_status is distinct from new.show_activity_status)
  execute function private.on_activity_visibility_change();

-- friendships(user_id, friend_id): user_id's friend is friend_id. Losing
-- that row means user_id no longer sees friend_id.
create function private.on_friendship_removed()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
begin
  perform private.inbox_send(old.user_id, jsonb_build_object('type', 'unfriended', 'userId', old.friend_id));
  return null;
end;
$$;

create trigger friendships_publish_removed
  after delete on public.friendships
  for each row execute function private.on_friendship_removed();

revoke execute on function
  private.on_presence_change(), private.on_activity_visibility_change(), private.on_friendship_removed()
from public, anon, authenticated;
