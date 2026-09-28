-- ============================================================================
-- 0013 · Storage buckets and object policies
--
-- Public buckets hold only low-sensitivity images (avatars, group logos,
-- event covers). Everything else is private: reading requires a user JWT
-- that passes these policies, or a short-lived signed URL issued by the API.
-- Object names always begin with the uploader's auth uid (user buckets) or
-- the entity id (community-media), and file names are generated UUIDs.
--
-- Postgres rows (photos, vehicle_documents) are the authority on ownership
-- and visibility; the folder prefix only controls where uploads may go.
-- During Phase 1 uploads use signed upload URLs created by the API, so the
-- INSERT policies below are for future direct uploads.
--
-- Permissions on hosted Supabase: storage.objects is owned by
-- supabase_storage_admin, not by `postgres` (the role migrations run as),
-- and `postgres` cannot SET ROLE to it. Supabase instead lists
-- storage.objects for `postgres` in its `supautils.policy_grants` setting,
-- which is the supported way for `postgres` to create, alter and drop
-- policies on that table. The policies below rely on that grant; the staging
-- pre-flight checks it before any migration is applied.
-- ============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('avatars',           'avatars',           true,  1048576,  array['image/jpeg', 'image/png', 'image/webp']),
  ('community-media',   'community-media',   true,  3145728,  array['image/jpeg', 'image/png', 'image/webp']),
  ('vehicle-photos',    'vehicle-photos',    false, 5242880,  array['image/jpeg', 'image/png', 'image/webp']),
  ('journey-photos',    'journey-photos',    false, 5242880,  array['image/jpeg', 'image/png', 'image/webp']),
  ('location-photos',   'location-photos',   false, 5242880,  array['image/jpeg', 'image/png', 'image/webp']),
  ('vehicle-documents', 'vehicle-documents', false, 10485760, array['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'])
on conflict (id) do update set
  public             = excluded.public,
  file_size_limit    = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- ─── avatars: {auth_uid}/{uuid}.jpg ──────────────────────────────────────────
-- Public bucket: reads go through public URLs and need no SELECT policy for
-- other users; owners need SELECT for upserts.
create policy driveos_avatars_select_own on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy driveos_avatars_insert_own on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy driveos_avatars_update_own on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy driveos_avatars_delete_own on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- ─── community-media: groups/{group_id}/… and events/{event_id}/… ────────────
create policy driveos_community_media_write on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'community-media'
    and (
      ((storage.foldername(name))[1] = 'groups'
        and private.group_role(private.try_uuid((storage.foldername(name))[2])) in ('owner', 'admin'))
      or
      ((storage.foldername(name))[1] = 'events'
        and private.is_event_organiser(private.try_uuid((storage.foldername(name))[2])))
    )
  );

create policy driveos_community_media_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'community-media'
    and (
      ((storage.foldername(name))[1] = 'groups'
        and private.group_role(private.try_uuid((storage.foldername(name))[2])) in ('owner', 'admin'))
      or
      ((storage.foldername(name))[1] = 'events'
        and private.is_event_organiser(private.try_uuid((storage.foldername(name))[2])))
    )
  );

-- ─── private photo buckets: {auth_uid}/{parent_id}/{photo_id}.jpg ────────────
-- Readable when a matching photos row exists and passes the photos rules.
create policy driveos_photos_select on storage.objects
  for select to authenticated
  using (
    bucket_id in ('vehicle-photos', 'journey-photos', 'location-photos')
    and private.can_read_photo_object(bucket_id, name)
  );

create policy driveos_photos_insert_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id in ('vehicle-photos', 'journey-photos', 'location-photos')
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy driveos_photos_delete_own on storage.objects
  for delete to authenticated
  using (
    bucket_id in ('vehicle-photos', 'journey-photos', 'location-photos')
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- ─── vehicle-documents: owner only, always ───────────────────────────────────
create policy driveos_documents_select_own on storage.objects
  for select to authenticated
  using (
    bucket_id = 'vehicle-documents'
    and private.owns_document_object(name)
  );

create policy driveos_documents_insert_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'vehicle-documents'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy driveos_documents_delete_own on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'vehicle-documents'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
