-- ============================================================================
-- 0003 · Vehicles and vehicle records
-- Child tables reference vehicles through the composite (id, owner_id) key so
-- a record can never be attached to somebody else's vehicle.
-- ============================================================================

-- ─── vehicles ────────────────────────────────────────────────────────────────
create table public.vehicles (
  id             uuid        primary key default gen_random_uuid(),
  owner_id       uuid        not null references public.profiles (id) on delete cascade,
  -- Client-generated reference: makes offline creates and future phone-data
  -- imports idempotent. Unique per owner when present.
  client_ref     text,
  nickname       text        not null,
  registration   text        not null default '',
  make           text        not null default '',
  model          text        not null default '',
  year           integer,
  colour         text        not null default '',
  fuel_type      text        not null default 'petrol',
  engine         text        not null default '',
  power          text        not null default '',
  torque         text        not null default '',
  zero_to_sixty  text        not null default '',
  top_speed_spec text        not null default '',
  mileage        integer     not null default 0,
  visibility     text        not null default 'private',
  is_active      boolean     not null default false,
  cover_photo_id uuid,       -- FK to photos added in 0008
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint vehicles_id_owner_key         unique (id, owner_id),
  constraint vehicles_owner_client_ref_key unique (owner_id, client_ref),
  constraint vehicles_nickname_length      check (char_length(nickname) between 1 and 60),
  constraint vehicles_registration_length  check (char_length(registration) <= 10),
  constraint vehicles_year_range           check (year is null or year between 1885 and 2100),
  constraint vehicles_fuel_type            check (fuel_type in ('petrol', 'diesel', 'electric', 'hybrid', 'other')),
  constraint vehicles_mileage_nonnegative  check (mileage >= 0),
  constraint vehicles_visibility           check (visibility in ('private', 'friends', 'public'))
);

-- At most one active vehicle per user.
create unique index vehicles_one_active_per_owner on public.vehicles (owner_id) where is_active;

create trigger vehicles_set_updated_at
  before update on public.vehicles
  for each row execute function private.set_updated_at();

alter table public.vehicles enable row level security;

-- ─── vehicle_service_records (service, repair, MOT history) ──────────────────
create table public.vehicle_service_records (
  id               uuid        primary key default gen_random_uuid(),
  vehicle_id       uuid        not null,
  owner_id         uuid        not null,
  record_type      text        not null,
  performed_on     date        not null,
  mileage          integer,
  title            text        not null,
  description      text        not null default '',
  garage_name      text        not null default '',
  cost_pence       integer,
  currency         text        not null default 'GBP',
  next_due_on      date,
  next_due_mileage integer,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint vehicle_service_records_vehicle_fk
    foreign key (vehicle_id, owner_id) references public.vehicles (id, owner_id) on delete cascade,
  constraint vehicle_service_records_type     check (record_type in ('service', 'repair', 'mot', 'inspection', 'other')),
  constraint vehicle_service_records_title    check (char_length(title) between 1 and 120),
  constraint vehicle_service_records_desc     check (char_length(description) <= 5000),
  constraint vehicle_service_records_numbers  check (
    (mileage is null or mileage >= 0) and
    (cost_pence is null or cost_pence >= 0) and
    (next_due_mileage is null or next_due_mileage >= 0)),
  constraint vehicle_service_records_currency check (currency ~ '^[A-Z]{3}$')
);

create index vehicle_service_records_vehicle_idx on public.vehicle_service_records (vehicle_id, performed_on desc);
create index vehicle_service_records_owner_idx   on public.vehicle_service_records (owner_id);

create trigger vehicle_service_records_set_updated_at
  before update on public.vehicle_service_records
  for each row execute function private.set_updated_at();

alter table public.vehicle_service_records enable row level security;

-- ─── vehicle_documents (always owner-only, private bucket) ───────────────────
create table public.vehicle_documents (
  id                uuid        primary key default gen_random_uuid(),
  vehicle_id        uuid        not null,
  owner_id          uuid        not null,
  doc_type          text        not null,
  title             text        not null default '',
  storage_path      text        not null,
  mime_type         text        not null,
  size_bytes        integer     not null,
  status            text        not null default 'pending',
  expires_on        date,
  service_record_id uuid        references public.vehicle_service_records (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint vehicle_documents_vehicle_fk
    foreign key (vehicle_id, owner_id) references public.vehicles (id, owner_id) on delete cascade,
  constraint vehicle_documents_storage_path_key unique (storage_path),
  -- A row may only reference a file inside its owner's own folder, so it can
  -- never be used to gain read access to somebody else's file.
  constraint vehicle_documents_path_in_owner_folder check (storage_path like owner_id::text || '/%'),
  constraint vehicle_documents_doc_type   check (doc_type in ('v5c', 'insurance', 'mot', 'service_receipt', 'warranty', 'other')),
  constraint vehicle_documents_title      check (char_length(title) <= 120),
  constraint vehicle_documents_mime_type  check (mime_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic')),
  constraint vehicle_documents_size       check (size_bytes > 0 and size_bytes <= 10485760),
  constraint vehicle_documents_status     check (status in ('pending', 'ready'))
);

create index vehicle_documents_vehicle_idx        on public.vehicle_documents (vehicle_id);
create index vehicle_documents_owner_expires_idx  on public.vehicle_documents (owner_id, expires_on);
create index vehicle_documents_service_record_idx on public.vehicle_documents (service_record_id) where service_record_id is not null;

create trigger vehicle_documents_set_updated_at
  before update on public.vehicle_documents
  for each row execute function private.set_updated_at();

alter table public.vehicle_documents enable row level security;

-- ─── vehicle_modifications ───────────────────────────────────────────────────
create table public.vehicle_modifications (
  id                 uuid        primary key default gen_random_uuid(),
  vehicle_id         uuid        not null,
  owner_id           uuid        not null,
  category           text        not null default 'other',
  name               text        not null,
  brand              text        not null default '',
  description        text        not null default '',
  installed_on       date,
  removed_on         date,
  mileage_at_install integer,
  cost_pence         integer,
  currency           text        not null default 'GBP',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint vehicle_modifications_vehicle_fk
    foreign key (vehicle_id, owner_id) references public.vehicles (id, owner_id) on delete cascade,
  constraint vehicle_modifications_category check (category in (
    'engine', 'exhaust', 'intake', 'forced_induction', 'suspension', 'brakes', 'wheels_tyres',
    'bodykit', 'interior', 'lighting', 'audio', 'electronics', 'other')),
  constraint vehicle_modifications_name     check (char_length(name) between 1 and 120),
  constraint vehicle_modifications_desc     check (char_length(description) <= 5000),
  constraint vehicle_modifications_dates    check (removed_on is null or installed_on is null or removed_on >= installed_on),
  constraint vehicle_modifications_numbers  check (
    (mileage_at_install is null or mileage_at_install >= 0) and (cost_pence is null or cost_pence >= 0)),
  constraint vehicle_modifications_currency check (currency ~ '^[A-Z]{3}$')
);

create index vehicle_modifications_vehicle_idx on public.vehicle_modifications (vehicle_id);
create index vehicle_modifications_owner_idx   on public.vehicle_modifications (owner_id);

create trigger vehicle_modifications_set_updated_at
  before update on public.vehicle_modifications
  for each row execute function private.set_updated_at();

alter table public.vehicle_modifications enable row level security;
