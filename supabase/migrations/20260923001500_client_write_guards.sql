-- ============================================================================
-- 0015 · Client write guards
--
-- RLS decides WHICH ROWS a user may update, not WHICH COLUMNS. Without this,
-- an owner allowed to rename their own journey could also rewrite its
-- distance and XP, an owner could raise their own XP, a group admin could
-- take over ownership, and so on.
--
-- Each table below lists the columns a client (roles `anon`/`authenticated`)
-- may change. Any other column change by a client is rejected, whatever
-- privileges are granted later. The API connects as the table owner and is
-- unaffected. `updated_at` is always allowed (a trigger overwrites it), and
-- generated columns are ignored (they are recomputed after this trigger).
-- ============================================================================

create function private.guard_client_update()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_old jsonb := to_jsonb(old);
  v_new jsonb := to_jsonb(new);
  v_col text;
begin
  if current_user not in ('anon', 'authenticated') then
    return new;
  end if;

  for v_col in select jsonb_object_keys(v_new) loop
    continue when v_col = 'updated_at' or v_col = any (tg_argv);
    if (v_new -> v_col) is distinct from (v_old -> v_col)
       and not exists (
         select 1 from pg_catalog.pg_attribute a
         where a.attrelid = tg_relid and a.attname = v_col and a.attgenerated <> ''
       ) then
      raise exception 'column "%" of "%" cannot be changed by clients', v_col, tg_table_name
        using errcode = '42501';
    end if;
  end loop;

  return new;
end;
$$;

revoke execute on function private.guard_client_update() from public, anon, authenticated;

-- Trigger names sort before *_set_updated_at so the guard runs first.

create trigger profiles_client_guard before update on public.profiles
  for each row execute function private.guard_client_update(
    'username', 'display_name', 'bio', 'avatar_path');

create trigger user_settings_client_guard before update on public.user_settings
  for each row execute function private.guard_client_update(
    'unit_system', 'profile_visibility', 'default_journey_visibility', 'default_location_visibility',
    'allow_friend_requests', 'share_live_location_in_convoys', 'notification_prefs');

create trigger vehicles_client_guard before update on public.vehicles
  for each row execute function private.guard_client_update(
    'nickname', 'registration', 'make', 'model', 'year', 'colour', 'fuel_type', 'engine', 'power',
    'torque', 'zero_to_sixty', 'top_speed_spec', 'mileage', 'visibility', 'is_active', 'cover_photo_id');

create trigger vehicle_service_records_client_guard before update on public.vehicle_service_records
  for each row execute function private.guard_client_update(
    'record_type', 'performed_on', 'mileage', 'title', 'description', 'garage_name', 'cost_pence',
    'currency', 'next_due_on', 'next_due_mileage');

-- Storage path, size, type and status are set by the upload flow only.
create trigger vehicle_documents_client_guard before update on public.vehicle_documents
  for each row execute function private.guard_client_update(
    'doc_type', 'title', 'expires_on', 'service_record_id');

create trigger vehicle_modifications_client_guard before update on public.vehicle_modifications
  for each row execute function private.guard_client_update(
    'category', 'name', 'brand', 'description', 'installed_on', 'removed_on', 'mileage_at_install',
    'cost_pence', 'currency');

create trigger photos_client_guard before update on public.photos
  for each row execute function private.guard_client_update('caption', 'sort_order');

create trigger journey_categories_client_guard before update on public.journey_categories
  for each row execute function private.guard_client_update('name', 'icon', 'colour', 'sort_order');

-- Stats, status, timing and XP are written by the server when a drive ends.
create trigger journeys_client_guard before update on public.journeys
  for each row execute function private.guard_client_update('name', 'notes', 'category_id', 'visibility');

-- `status` is the moderation flag: owners cannot un-hide a moderated spot.
create trigger saved_locations_client_guard before update on public.saved_locations
  for each row execute function private.guard_client_update(
    'kind', 'category', 'name', 'description', 'address', 'lat', 'lng', 'route_polyline',
    'visibility', 'cover_photo_id');

create trigger friend_requests_client_guard before update on public.friend_requests
  for each row execute function private.guard_client_update('status', 'responded_at');

-- Ownership changes are server-only.
create trigger groups_client_guard before update on public.groups
  for each row execute function private.guard_client_update(
    'name', 'description', 'logo_path', 'is_public', 'membership_method', 'primary_location',
    'vehicle_interests');

-- A membership row cannot be moved to another group or user.
create trigger group_members_client_guard before update on public.group_members
  for each row execute function private.guard_client_update('role', 'status');

create trigger events_client_guard before update on public.events
  for each row execute function private.guard_client_update(
    'name', 'description', 'cover_path', 'location_name', 'lat', 'lng', 'starts_at', 'ends_at',
    'timezone', 'event_type', 'visibility', 'capacity', 'entry_cost', 'vehicle_category');

create trigger convoys_client_guard before update on public.convoys
  for each row execute function private.guard_client_update(
    'name', 'description', 'destination_name', 'destination_lat', 'destination_lng', 'visibility',
    'starts_at', 'status', 'started_at', 'ended_at', 'max_participants');

create trigger notifications_client_guard before update on public.notifications
  for each row execute function private.guard_client_update('read_at');

create trigger push_devices_client_guard before update on public.push_devices
  for each row execute function private.guard_client_update(
    'expo_push_token', 'platform', 'app_version', 'enabled', 'last_seen_at');
