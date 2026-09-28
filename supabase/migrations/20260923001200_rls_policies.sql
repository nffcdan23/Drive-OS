-- ============================================================================
-- 0012 · Row Level Security policies
--
-- Access model for this stage:
--   * RLS is enabled on every table (done in each table's migration).
--   * `anon` and `authenticated` hold NO table privileges yet, so nothing is
--     reachable through the Data API with the publishable key, even with a
--     valid user JWT. The Express API connects as the table owner, which RLS
--     does not restrict, and enforces the same rules in its queries.
--   * These policies define exactly what each signed-in user may do. They
--     take effect table by table once a later migration GRANTs privileges to
--     `authenticated` for direct app access.
-- Writes that must stay server-only (XP, stats, notifications, friendships,
-- joins with capacity rules, journey start/complete) deliberately have no
-- policy, so they are impossible even after privileges are granted.
-- ============================================================================

-- Belt and braces: whatever the defaults, no client role holds privileges.
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;

-- ─── profiles ────────────────────────────────────────────────────────────────
-- Basic identity (username, display name, avatar, level) is visible to every
-- signed-in user who is not blocked either way. Bio and stats are restricted
-- further by column privileges when direct access is granted.
create policy profiles_select on public.profiles
  for select to authenticated
  using (
    id = (select auth.uid())
    or not private.is_blocked_between(id, (select auth.uid()))
  );

create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- ─── user_settings (owner only) ──────────────────────────────────────────────
create policy user_settings_select_own on public.user_settings
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy user_settings_update_own on public.user_settings
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ─── user_blocks (owner only) ────────────────────────────────────────────────
create policy user_blocks_select_own on public.user_blocks
  for select to authenticated
  using (blocker_id = (select auth.uid()));

create policy user_blocks_insert_own on public.user_blocks
  for insert to authenticated
  with check (blocker_id = (select auth.uid()));

create policy user_blocks_delete_own on public.user_blocks
  for delete to authenticated
  using (blocker_id = (select auth.uid()));

-- ─── vehicles ────────────────────────────────────────────────────────────────
create policy vehicles_select on public.vehicles
  for select to authenticated
  using (owner_id = (select auth.uid()) or private.can_view(owner_id, visibility));

create policy vehicles_insert_own on public.vehicles
  for insert to authenticated
  with check (owner_id = (select auth.uid()));

create policy vehicles_update_own on public.vehicles
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy vehicles_delete_own on public.vehicles
  for delete to authenticated
  using (owner_id = (select auth.uid()));

-- ─── vehicle_service_records (owner only, always) ────────────────────────────
create policy vehicle_service_records_all_own on public.vehicle_service_records
  for all to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

-- ─── vehicle_documents (owner only, always) ──────────────────────────────────
create policy vehicle_documents_select_own on public.vehicle_documents
  for select to authenticated
  using (owner_id = (select auth.uid()));

-- New rows start 'pending'; the API marks them 'ready' after checking the
-- uploaded file.
create policy vehicle_documents_insert_own on public.vehicle_documents
  for insert to authenticated
  with check (owner_id = (select auth.uid()) and status = 'pending');

create policy vehicle_documents_update_own on public.vehicle_documents
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy vehicle_documents_delete_own on public.vehicle_documents
  for delete to authenticated
  using (owner_id = (select auth.uid()));

-- ─── vehicle_modifications (visibility follows the vehicle) ──────────────────
create policy vehicle_modifications_select on public.vehicle_modifications
  for select to authenticated
  using (owner_id = (select auth.uid()) or private.can_view_vehicle(vehicle_id));

create policy vehicle_modifications_insert_own on public.vehicle_modifications
  for insert to authenticated
  with check (owner_id = (select auth.uid()));

create policy vehicle_modifications_update_own on public.vehicle_modifications
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy vehicle_modifications_delete_own on public.vehicle_modifications
  for delete to authenticated
  using (owner_id = (select auth.uid()));

-- ─── photos (visibility follows the parent) ──────────────────────────────────
create policy photos_select on public.photos
  for select to authenticated
  using (
    owner_id = (select auth.uid())
    or (
      status = 'ready'
      and case
            when vehicle_id  is not null then private.can_view_vehicle(vehicle_id)
            when journey_id  is not null then private.can_view_journey(journey_id)
            when location_id is not null then private.can_view_location(location_id)
            else false
          end
    )
  );

-- Location photos: the location must also belong to the uploader (vehicle
-- and journey ownership is already guaranteed by the composite foreign keys).
-- New rows start 'pending'; the API marks them 'ready' after checking the file.
create policy photos_insert_own on public.photos
  for insert to authenticated
  with check (
    owner_id = (select auth.uid())
    and status = 'pending'
    and (location_id is null or private.owns_location(location_id))
  );

create policy photos_update_own on public.photos
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy photos_delete_own on public.photos
  for delete to authenticated
  using (owner_id = (select auth.uid()));

-- ─── journey_categories ──────────────────────────────────────────────────────
create policy journey_categories_select on public.journey_categories
  for select to authenticated
  using (owner_id is null or owner_id = (select auth.uid()));

create policy journey_categories_insert_own on public.journey_categories
  for insert to authenticated
  with check (owner_id = (select auth.uid()));

create policy journey_categories_update_own on public.journey_categories
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy journey_categories_delete_own on public.journey_categories
  for delete to authenticated
  using (owner_id = (select auth.uid()));

-- ─── journeys ────────────────────────────────────────────────────────────────
-- Start and completion are server-only (no INSERT policy; stats columns are
-- excluded from UPDATE privileges when direct access is granted).
create policy journeys_select on public.journeys
  for select to authenticated
  using (
    owner_id = (select auth.uid())
    or (status = 'completed' and private.can_view(owner_id, visibility))
  );

create policy journeys_update_own on public.journeys
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy journeys_delete_own on public.journeys
  for delete to authenticated
  using (owner_id = (select auth.uid()));

-- ─── journey_route_points (owner only, read only) ────────────────────────────
-- Raw points reveal where people live and work: never shown to anyone else.
-- Other users only ever see journeys.public_route_polyline.
create policy journey_route_points_select_own on public.journey_route_points
  for select to authenticated
  using (private.owns_journey(journey_id));

-- ─── journey_routes (owner only, read only) ──────────────────────────────────
create policy journey_routes_select_own on public.journey_routes
  for select to authenticated
  using (owner_id = (select auth.uid()));

-- ─── saved_locations ─────────────────────────────────────────────────────────
create policy saved_locations_select on public.saved_locations
  for select to authenticated
  using (
    owner_id = (select auth.uid())
    or (status = 'active' and private.can_view(owner_id, visibility))
  );

create policy saved_locations_insert_own on public.saved_locations
  for insert to authenticated
  with check (owner_id = (select auth.uid()) and status = 'active');

create policy saved_locations_update_own on public.saved_locations
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy saved_locations_delete_own on public.saved_locations
  for delete to authenticated
  using (owner_id = (select auth.uid()));

-- ─── friendships (read only; written by the server in pairs) ─────────────────
create policy friendships_select_own on public.friendships
  for select to authenticated
  using (user_id = (select auth.uid()) or friend_id = (select auth.uid()));

-- ─── friend_requests ─────────────────────────────────────────────────────────
create policy friend_requests_select_involved on public.friend_requests
  for select to authenticated
  using (from_user_id = (select auth.uid()) or to_user_id = (select auth.uid()));

create policy friend_requests_insert_own on public.friend_requests
  for insert to authenticated
  with check (
    from_user_id = (select auth.uid())
    and status = 'pending'
    and not private.is_blocked_between(from_user_id, to_user_id)
    and not private.is_friend(from_user_id, to_user_id)
    and private.accepts_friend_requests(to_user_id)
  );

-- Sender may cancel; recipient may decline. Accepting creates friendships
-- and is server-only.
create policy friend_requests_sender_cancel on public.friend_requests
  for update to authenticated
  using (from_user_id = (select auth.uid()) and status = 'pending')
  with check (from_user_id = (select auth.uid()) and status = 'cancelled');

create policy friend_requests_recipient_decline on public.friend_requests
  for update to authenticated
  using (to_user_id = (select auth.uid()) and status = 'pending')
  with check (to_user_id = (select auth.uid()) and status = 'declined');

-- ─── groups ──────────────────────────────────────────────────────────────────
-- Creation is server-only (it must also create the owner membership).
create policy groups_select on public.groups
  for select to authenticated
  using (private.can_view_group(id));

create policy groups_update_admin on public.groups
  for update to authenticated
  using (private.group_role(id) in ('owner', 'admin'))
  with check (private.group_role(id) in ('owner', 'admin'));

create policy groups_delete_owner on public.groups
  for delete to authenticated
  using (owner_id = (select auth.uid()));

-- ─── group_members ───────────────────────────────────────────────────────────
-- Joining (open / request / invite / code rules) is server-only.
create policy group_members_select on public.group_members
  for select to authenticated
  using (user_id = (select auth.uid()) or private.can_view_group(group_id));

-- Owner manages anyone but cannot hand out 'owner'; admins manage members.
create policy group_members_update_admin on public.group_members
  for update to authenticated
  using (
    private.group_role(group_id) = 'owner'
    or (private.group_role(group_id) = 'admin' and role = 'member')
  )
  with check (
    role <> 'owner'
    and (
      private.group_role(group_id) = 'owner'
      or (private.group_role(group_id) = 'admin' and role = 'member')
    )
  );

-- Members may leave (the owner must transfer ownership first); owners and
-- admins may remove ordinary members.
create policy group_members_delete on public.group_members
  for delete to authenticated
  using (
    (user_id = (select auth.uid()) and role <> 'owner')
    or (role = 'member' and private.group_role(group_id) in ('owner', 'admin'))
  );

-- ─── events ──────────────────────────────────────────────────────────────────
create policy events_select on public.events
  for select to authenticated
  using (private.can_view_event(id));

create policy events_insert on public.events
  for insert to authenticated
  with check (
    organiser_id = (select auth.uid())
    and (group_id is null or private.group_role(group_id) in ('owner', 'admin'))
  );

create policy events_update on public.events
  for update to authenticated
  using (
    organiser_id = (select auth.uid())
    or (group_id is not null and private.group_role(group_id) in ('owner', 'admin'))
  )
  with check (
    organiser_id = (select auth.uid())
    or (group_id is not null and private.group_role(group_id) in ('owner', 'admin'))
  );

create policy events_delete on public.events
  for delete to authenticated
  using (
    organiser_id = (select auth.uid())
    or (group_id is not null and private.group_role(group_id) in ('owner', 'admin'))
  );

-- ─── event_rsvps ─────────────────────────────────────────────────────────────
-- RSVPs (capacity-checked) are server-only; users may withdraw their own.
create policy event_rsvps_select on public.event_rsvps
  for select to authenticated
  using (user_id = (select auth.uid()) or private.can_view_event(event_id));

create policy event_rsvps_delete_own on public.event_rsvps
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- ─── convoys ─────────────────────────────────────────────────────────────────
-- Creation is server-only (it must also create the leader participant row).
create policy convoys_select on public.convoys
  for select to authenticated
  using (private.can_view_convoy(id));

create policy convoys_update_owner on public.convoys
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

create policy convoys_delete_owner on public.convoys
  for delete to authenticated
  using (owner_id = (select auth.uid()));

-- ─── convoy_participants ─────────────────────────────────────────────────────
-- Joining (visibility, join code, max participants) is server-only.
create policy convoy_participants_select on public.convoy_participants
  for select to authenticated
  using (user_id = (select auth.uid()) or private.can_view_convoy(convoy_id));

create policy convoy_participants_leave on public.convoy_participants
  for delete to authenticated
  using (user_id = (select auth.uid()) and role <> 'leader');

-- ─── notifications (owner only; created by the server) ───────────────────────
create policy notifications_select_own on public.notifications
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy notifications_update_own on public.notifications
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy notifications_delete_own on public.notifications
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- ─── push_devices (owner only) ───────────────────────────────────────────────
create policy push_devices_all_own on public.push_devices
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ─── content_reports ─────────────────────────────────────────────────────────
create policy content_reports_select_own on public.content_reports
  for select to authenticated
  using (reporter_id = (select auth.uid()));

create policy content_reports_insert_own on public.content_reports
  for insert to authenticated
  with check (reporter_id = (select auth.uid()) and status = 'open' and resolved_at is null);

-- ─── achievements ────────────────────────────────────────────────────────────
create policy achievements_select on public.achievements
  for select to authenticated
  using (not is_hidden);

create policy user_achievements_select on public.user_achievements
  for select to authenticated
  using (user_id = (select auth.uid()) or private.profile_details_visible(user_id));
