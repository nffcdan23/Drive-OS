-- ============================================================================
-- 0008 · Photos and Storage clean-up
-- File bytes live in Supabase Storage; Postgres holds the metadata and is the
-- authority on who owns and who may see each file. Deleting a row (directly
-- or by cascade) queues the Storage object for deletion by a worker, because
-- Storage objects must be removed through the Storage API.
-- ============================================================================

-- ─── photos (vehicle, journey, location) ─────────────────────────────────────
create table public.photos (
  id           uuid        primary key default gen_random_uuid(),
  owner_id     uuid        not null references public.profiles (id) on delete cascade,
  vehicle_id   uuid,
  journey_id   uuid,
  location_id  uuid        references public.saved_locations (id) on delete cascade,
  bucket       text        not null,
  storage_path text        not null,
  thumb_path   text,
  mime_type    text        not null,
  size_bytes   integer     not null,
  width        integer,
  height       integer,
  caption      text        not null default '',
  sort_order   integer     not null default 0,
  status       text        not null default 'pending',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint photos_vehicle_fk
    foreign key (vehicle_id, owner_id) references public.vehicles (id, owner_id) on delete cascade,
  constraint photos_journey_fk
    foreign key (journey_id, owner_id) references public.journeys (id, owner_id) on delete cascade,
  constraint photos_storage_path_key unique (storage_path),
  constraint photos_thumb_path_key   unique (thumb_path),
  -- A row may only reference files inside its owner's own folder, so it can
  -- never be used to gain read access to somebody else's file.
  constraint photos_paths_in_owner_folder check (
    storage_path like owner_id::text || '/%' and
    (thumb_path is null or thumb_path like owner_id::text || '/%')),
  constraint photos_one_parent       check (num_nonnulls(vehicle_id, journey_id, location_id) = 1),
  constraint photos_bucket_matches_parent check (
    (vehicle_id  is not null and bucket = 'vehicle-photos') or
    (journey_id  is not null and bucket = 'journey-photos') or
    (location_id is not null and bucket = 'location-photos')),
  constraint photos_mime_type  check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  constraint photos_size       check (size_bytes > 0 and size_bytes <= 5242880),
  constraint photos_dimensions check ((width is null or width > 0) and (height is null or height > 0)),
  constraint photos_caption    check (char_length(caption) <= 500),
  constraint photos_status     check (status in ('pending', 'ready'))
);

create index photos_owner_idx    on public.photos (owner_id);
create index photos_vehicle_idx  on public.photos (vehicle_id)  where vehicle_id  is not null;
create index photos_journey_idx  on public.photos (journey_id)  where journey_id  is not null;
create index photos_location_idx on public.photos (location_id) where location_id is not null;

create trigger photos_set_updated_at
  before update on public.photos
  for each row execute function private.set_updated_at();

alter table public.photos enable row level security;

-- Cover photos (the photo row must exist; the API checks it belongs to the
-- same vehicle / location).
alter table public.vehicles
  add constraint vehicles_cover_photo_fk
  foreign key (cover_photo_id) references public.photos (id) on delete set null;
alter table public.saved_locations
  add constraint saved_locations_cover_photo_fk
  foreign key (cover_photo_id) references public.photos (id) on delete set null;
create index vehicles_cover_photo_idx        on public.vehicles (cover_photo_id)        where cover_photo_id is not null;
create index saved_locations_cover_photo_idx on public.saved_locations (cover_photo_id) where cover_photo_id is not null;

-- ─── Storage deletion queue ──────────────────────────────────────────────────
create table private.storage_delete_queue (
  id         bigint      generated always as identity primary key,
  bucket     text        not null,
  path       text        not null,
  queued_at  timestamptz not null default now(),
  attempts   integer     not null default 0,
  last_error text
);

create index storage_delete_queue_queued_idx on private.storage_delete_queue (queued_at);

-- Queues Storage objects whose path columns are deleted or changed.
-- TG_ARGV[0]: bucket name ('' = read it from the row's `bucket` column)
-- TG_ARGV[1..]: names of the path columns to watch
create function private.queue_storage_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old    jsonb := to_jsonb(old);
  v_new    jsonb := case when tg_op = 'UPDATE' then to_jsonb(new) end;
  v_bucket text  := coalesce(nullif(tg_argv[0], ''), v_old ->> 'bucket');
  v_col    text;
begin
  foreach v_col in array tg_argv[1:tg_nargs - 1] loop
    if v_old ->> v_col is not null
       and (tg_op = 'DELETE' or (v_new ->> v_col) is distinct from (v_old ->> v_col)) then
      insert into private.storage_delete_queue (bucket, path) values (v_bucket, v_old ->> v_col);
    end if;
  end loop;
  return null;
end;
$$;

create trigger photos_queue_storage_delete
  after delete or update of storage_path, thumb_path on public.photos
  for each row execute function private.queue_storage_delete('', 'storage_path', 'thumb_path');

create trigger vehicle_documents_queue_storage_delete
  after delete or update of storage_path on public.vehicle_documents
  for each row execute function private.queue_storage_delete('vehicle-documents', 'storage_path');

create trigger profiles_queue_storage_delete
  after delete or update of avatar_path on public.profiles
  for each row execute function private.queue_storage_delete('avatars', 'avatar_path');

create trigger groups_queue_storage_delete
  after delete or update of logo_path on public.groups
  for each row execute function private.queue_storage_delete('community-media', 'logo_path');

create trigger events_queue_storage_delete
  after delete or update of cover_path on public.events
  for each row execute function private.queue_storage_delete('community-media', 'cover_path');
