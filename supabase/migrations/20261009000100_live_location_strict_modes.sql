-- ============================================================================
-- 0019 · Live location: strict WHEN semantics
--
-- 0018 let "While Using Derwent" keep sharing in the background during a
-- drive. The modes are now strictly separate:
--   while_using    shared ONLY while the app is in the foreground. Leaving
--                  the app (background, locked phone, signed out) withdraws
--                  the position at once, even mid-drive. Recording is
--                  unaffected (it never depended on sharing).
--   while_driving  shared while a drive is being recorded, on screen or not.
-- Only the two functions that decide this change; every WHO rule (friends,
-- selected friends, Convoys, blocks) is untouched.
-- ============================================================================

-- A position is current only if the owner's WHEN holds right now:
-- while_using needs the app in the foreground, while_driving a drive.
create or replace function private.can_see_live_location(p_owner uuid, p_viewer uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select private.live_location_granted(p_owner, p_viewer)
    and exists (
      select 1 from public.live_locations l
      join public.user_settings s on s.user_id = l.user_id
      join public.user_presence p on p.user_id = l.user_id
      where l.user_id = p_owner and l.expires_at > now()
        and p.app_state <> 'signed_out'
        and ((s.location_sharing = 'while_using' and p.app_state = 'foreground')
             or (s.location_sharing = 'while_driving' and l.driving))
    )
$$;

-- The owner's presence changed: the server withdraws a position whose WHEN
-- no longer holds (deleting it tells every viewer, 0018).
--   while_using:   app no longer in the foreground -> removed (driving or not)
--   while_driving: drive ended                     -> removed
--   signed out                                     -> removed
--   while_using, drive ended on screen             -> kept, no longer "driving"
create or replace function private.on_presence_live_location()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  mode text := (select s.location_sharing from public.user_settings s where s.user_id = new.user_id);
begin
  if not exists (select 1 from public.live_locations where user_id = new.user_id) then
    return null;
  end if;
  if new.app_state = 'signed_out'
     or not ((mode = 'while_using' and new.app_state = 'foreground')
             or (mode = 'while_driving' and new.driving)) then
    delete from public.live_locations where user_id = new.user_id;
  elsif old.driving and not new.driving then
    update public.live_locations set driving = false where user_id = new.user_id;
  end if;
  return null;
end;
$$;

-- create or replace keeps the existing grants; restated for clarity.
revoke execute on function private.can_see_live_location(uuid, uuid), private.on_presence_live_location()
  from public, anon, authenticated;
