/**
 * Drizzle mirror of the Supabase schema.
 *
 * The SQL migrations in `supabase/migrations/` are the source of truth. This
 * file only gives the API typed queries against that schema; it is never used
 * to create or change tables (no drizzle-kit push / generate). Constraints,
 * foreign keys, indexes, triggers and RLS policies live in the SQL only.
 *
 * `supabase/tests/local/run.sh` checks this file against a database built
 * from the migrations (tables, columns, types, nullability, defaults).
 *
 * Not yet wired into the API: the running Express code still uses the legacy
 * schema in `./index.ts` until the Phase 4 integration.
 */
import { sql } from 'drizzle-orm';
import {
  pgTable, uuid, text, integer, real, doublePrecision, boolean, timestamp, date, jsonb,
  primaryKey, customType,
} from 'drizzle-orm/pg-core';

/** PostGIS geography(Point, 4326); generated from lat/lng, read-only here. */
const geographyPoint = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'geography(Point,4326)';
  },
});

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

// ─── Profiles, settings, blocks ─────────────────────────────────────────────

export const profiles = pgTable('profiles', {
  id:              uuid('id').primaryKey(), // = auth.users.id
  username:        text('username'),
  displayName:     text('display_name').notNull().default('Driver'),
  bio:             text('bio').notNull().default(''),
  avatarPath:      text('avatar_path'),
  friendCode:      text('friend_code').notNull().default(sql`private.generate_friend_code()`),
  xp:              integer('xp').notNull().default(0),
  level:           integer('level').notNull().generatedAlwaysAs(sql`private.level_for_xp(xp)`),
  totalDistanceKm: doublePrecision('total_distance_km').notNull().default(0),
  totalJourneys:   integer('total_journeys').notNull().default(0),
  createdAt:       timestamptz('created_at').notNull().defaultNow(),
  updatedAt:       timestamptz('updated_at').notNull().defaultNow(),
});

export const userSettings = pgTable('user_settings', {
  userId:                     uuid('user_id').primaryKey(),
  unitSystem:                 text('unit_system').notNull().default('auto'),
  profileVisibility:          text('profile_visibility').notNull().default('public'),
  defaultJourneyVisibility:   text('default_journey_visibility').notNull().default('private'),
  defaultLocationVisibility:  text('default_location_visibility').notNull().default('private'),
  allowFriendRequests:        text('allow_friend_requests').notNull().default('everyone'),
  shareLiveLocationInConvoys: boolean('share_live_location_in_convoys').notNull().default(true),
  notificationPrefs:          jsonb('notification_prefs').$type<Record<string, unknown>>().notNull().default({}),
  createdAt:                  timestamptz('created_at').notNull().defaultNow(),
  updatedAt:                  timestamptz('updated_at').notNull().defaultNow(),
});

export const userBlocks = pgTable('user_blocks', {
  blockerId: uuid('blocker_id').notNull(),
  blockedId: uuid('blocked_id').notNull(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.blockerId, t.blockedId] })]);

// ─── Vehicles and records ───────────────────────────────────────────────────

export const vehicles = pgTable('vehicles', {
  id:           uuid('id').primaryKey().defaultRandom(),
  ownerId:      uuid('owner_id').notNull(),
  clientRef:    text('client_ref'),
  nickname:     text('nickname').notNull(),
  registration: text('registration').notNull().default(''),
  make:         text('make').notNull().default(''),
  model:        text('model').notNull().default(''),
  year:         integer('year'),
  colour:       text('colour').notNull().default(''),
  fuelType:     text('fuel_type').notNull().default('petrol'),
  engine:       text('engine').notNull().default(''),
  power:        text('power').notNull().default(''),
  torque:       text('torque').notNull().default(''),
  zeroToSixty:  text('zero_to_sixty').notNull().default(''),
  topSpeedSpec: text('top_speed_spec').notNull().default(''),
  mileage:      integer('mileage').notNull().default(0),
  visibility:   text('visibility').notNull().default('private'),
  isActive:     boolean('is_active').notNull().default(false),
  coverPhotoId: uuid('cover_photo_id'),
  createdAt:    timestamptz('created_at').notNull().defaultNow(),
  updatedAt:    timestamptz('updated_at').notNull().defaultNow(),
});

export const vehicleServiceRecords = pgTable('vehicle_service_records', {
  id:             uuid('id').primaryKey().defaultRandom(),
  vehicleId:      uuid('vehicle_id').notNull(),
  ownerId:        uuid('owner_id').notNull(),
  recordType:     text('record_type').notNull(),
  performedOn:    date('performed_on').notNull(),
  mileage:        integer('mileage'),
  title:          text('title').notNull(),
  description:    text('description').notNull().default(''),
  garageName:     text('garage_name').notNull().default(''),
  costPence:      integer('cost_pence'),
  currency:       text('currency').notNull().default('GBP'),
  nextDueOn:      date('next_due_on'),
  nextDueMileage: integer('next_due_mileage'),
  createdAt:      timestamptz('created_at').notNull().defaultNow(),
  updatedAt:      timestamptz('updated_at').notNull().defaultNow(),
});

export const vehicleDocuments = pgTable('vehicle_documents', {
  id:              uuid('id').primaryKey().defaultRandom(),
  vehicleId:       uuid('vehicle_id').notNull(),
  ownerId:         uuid('owner_id').notNull(),
  docType:         text('doc_type').notNull(),
  title:           text('title').notNull().default(''),
  storagePath:     text('storage_path').notNull(),
  mimeType:        text('mime_type').notNull(),
  sizeBytes:       integer('size_bytes').notNull(),
  status:          text('status').notNull().default('pending'),
  expiresOn:       date('expires_on'),
  serviceRecordId: uuid('service_record_id'),
  createdAt:       timestamptz('created_at').notNull().defaultNow(),
  updatedAt:       timestamptz('updated_at').notNull().defaultNow(),
});

export const vehicleModifications = pgTable('vehicle_modifications', {
  id:               uuid('id').primaryKey().defaultRandom(),
  vehicleId:        uuid('vehicle_id').notNull(),
  ownerId:          uuid('owner_id').notNull(),
  category:         text('category').notNull().default('other'),
  name:             text('name').notNull(),
  brand:            text('brand').notNull().default(''),
  description:      text('description').notNull().default(''),
  installedOn:      date('installed_on'),
  removedOn:        date('removed_on'),
  mileageAtInstall: integer('mileage_at_install'),
  costPence:        integer('cost_pence'),
  currency:         text('currency').notNull().default('GBP'),
  createdAt:        timestamptz('created_at').notNull().defaultNow(),
  updatedAt:        timestamptz('updated_at').notNull().defaultNow(),
});

// ─── Groups, convoys, events ────────────────────────────────────────────────

export const groups = pgTable('groups', {
  id:               uuid('id').primaryKey().defaultRandom(),
  ownerId:          uuid('owner_id').notNull(),
  name:             text('name').notNull(),
  description:      text('description').notNull().default(''),
  logoPath:         text('logo_path'),
  isPublic:         boolean('is_public').notNull().default(true),
  membershipMethod: text('membership_method').notNull().default('open'),
  joinCode:         text('join_code'),
  primaryLocation:  text('primary_location').notNull().default(''),
  vehicleInterests: text('vehicle_interests').notNull().default(''),
  createdAt:        timestamptz('created_at').notNull().defaultNow(),
  updatedAt:        timestamptz('updated_at').notNull().defaultNow(),
});

export const groupMembers = pgTable('group_members', {
  groupId:   uuid('group_id').notNull(),
  userId:    uuid('user_id').notNull(),
  role:      text('role').notNull().default('member'),
  status:    text('status').notNull().default('active'),
  invitedBy: uuid('invited_by'),
  joinedAt:  timestamptz('joined_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.groupId, t.userId] })]);

export const convoys = pgTable('convoys', {
  id:              uuid('id').primaryKey().defaultRandom(),
  ownerId:         uuid('owner_id').notNull(),
  groupId:         uuid('group_id'),
  name:            text('name').notNull(),
  description:     text('description').notNull().default(''),
  destinationName: text('destination_name').notNull().default(''),
  destinationLat:  doublePrecision('destination_lat'),
  destinationLng:  doublePrecision('destination_lng'),
  visibility:      text('visibility').notNull().default('public'),
  joinCode:        text('join_code'),
  startsAt:        timestamptz('starts_at').notNull(),
  status:          text('status').notNull().default('forming'),
  startedAt:       timestamptz('started_at'),
  endedAt:         timestamptz('ended_at'),
  maxParticipants: integer('max_participants'),
  createdAt:       timestamptz('created_at').notNull().defaultNow(),
  updatedAt:       timestamptz('updated_at').notNull().defaultNow(),
});

export const convoyParticipants = pgTable('convoy_participants', {
  convoyId: uuid('convoy_id').notNull(),
  userId:   uuid('user_id').notNull(),
  role:     text('role').notNull().default('member'),
  joinedAt: timestamptz('joined_at').notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.convoyId, t.userId] })]);

export const events = pgTable('events', {
  id:              uuid('id').primaryKey().defaultRandom(),
  organiserId:     uuid('organiser_id').notNull(),
  groupId:         uuid('group_id'),
  name:            text('name').notNull(),
  description:     text('description').notNull().default(''),
  coverPath:       text('cover_path'),
  locationName:    text('location_name').notNull().default(''),
  lat:             doublePrecision('lat'),
  lng:             doublePrecision('lng'),
  geog:            geographyPoint('geog').generatedAlwaysAs(
    sql`extensions.st_setsrid(extensions.st_makepoint(lng, lat), 4326)::extensions.geography`),
  startsAt:        timestamptz('starts_at').notNull(),
  endsAt:          timestamptz('ends_at'),
  timezone:        text('timezone').notNull().default('Europe/London'),
  eventType:       text('event_type').notNull().default('other'),
  visibility:      text('visibility').notNull().default('public'),
  capacity:        integer('capacity'),
  entryCost:       text('entry_cost').notNull().default('Free'),
  vehicleCategory: text('vehicle_category').notNull().default('All'),
  createdAt:       timestamptz('created_at').notNull().defaultNow(),
  updatedAt:       timestamptz('updated_at').notNull().defaultNow(),
});

export const eventRsvps = pgTable('event_rsvps', {
  eventId:   uuid('event_id').notNull(),
  userId:    uuid('user_id').notNull(),
  status:    text('status').notNull(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.eventId, t.userId] })]);

// ─── Journeys ───────────────────────────────────────────────────────────────

export const journeyCategories = pgTable('journey_categories', {
  id:        uuid('id').primaryKey().defaultRandom(),
  ownerId:   uuid('owner_id'), // null = shared default
  isDefault: boolean('is_default').notNull().generatedAlwaysAs(sql`(owner_id is null)`),
  name:      text('name').notNull(),
  icon:      text('icon').notNull(),
  colour:    text('colour').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
});

export const journeys = pgTable('journeys', {
  id:                  uuid('id').primaryKey().defaultRandom(),
  ownerId:             uuid('owner_id').notNull(),
  clientRef:           text('client_ref'),
  vehicleId:           uuid('vehicle_id'),
  categoryId:          uuid('category_id'),
  convoyId:            uuid('convoy_id'),
  name:                text('name').notNull().default('Unnamed Journey'),
  notes:               text('notes').notNull().default(''),
  status:              text('status').notNull().default('active'),
  visibility:          text('visibility').notNull().default('private'),
  journeyType:         text('journey_type').notNull().default('personal'),
  startedAt:           timestamptz('started_at').notNull(),
  endedAt:             timestamptz('ended_at'),
  timezone:            text('timezone').notNull().default('Europe/London'),
  durationSeconds:     integer('duration_seconds').notNull().default(0),
  distanceKm:          doublePrecision('distance_km').notNull().default(0),
  avgSpeedKmh:         doublePrecision('avg_speed_kmh').notNull().default(0),
  topSpeedKmh:         doublePrecision('top_speed_kmh').notNull().default(0),
  xpEarned:            integer('xp_earned').notNull().default(0),
  vehicleSnapshot:     jsonb('vehicle_snapshot').$type<Record<string, unknown>>(),
  routePolyline:       text('route_polyline'),
  publicRoutePolyline: text('public_route_polyline'),
  routePointCount:     integer('route_point_count').notNull().default(0),
  startLat:            doublePrecision('start_lat'),
  startLng:            doublePrecision('start_lng'),
  endLat:              doublePrecision('end_lat'),
  endLng:              doublePrecision('end_lng'),
  bboxMinLat:          doublePrecision('bbox_min_lat'),
  bboxMinLng:          doublePrecision('bbox_min_lng'),
  bboxMaxLat:          doublePrecision('bbox_max_lat'),
  bboxMaxLng:          doublePrecision('bbox_max_lng'),
  createdAt:           timestamptz('created_at').notNull().defaultNow(),
  updatedAt:           timestamptz('updated_at').notNull().defaultNow(),
});

export const journeyRoutePoints = pgTable('journey_route_points', {
  journeyId:  uuid('journey_id').notNull(),
  recordedAt: timestamptz('recorded_at').notNull(),
  latitude:   doublePrecision('latitude').notNull(),
  longitude:  doublePrecision('longitude').notNull(),
  speedKmh:   real('speed_kmh').notNull().default(0),
  headingDeg: real('heading_deg'),
  accuracyM:  real('accuracy_m'),
  altitudeM:  real('altitude_m'),
}, (t) => [primaryKey({ columns: [t.journeyId, t.recordedAt] })]);

// ─── Social ─────────────────────────────────────────────────────────────────

export const friendships = pgTable('friendships', {
  userId:    uuid('user_id').notNull(),
  friendId:  uuid('friend_id').notNull(),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.userId, t.friendId] })]);

export const friendRequests = pgTable('friend_requests', {
  id:          uuid('id').primaryKey().defaultRandom(),
  fromUserId:  uuid('from_user_id').notNull(),
  toUserId:    uuid('to_user_id').notNull(),
  status:      text('status').notNull().default('pending'),
  createdAt:   timestamptz('created_at').notNull().defaultNow(),
  respondedAt: timestamptz('responded_at'),
});

// ─── Saved locations / Beauty Spots ─────────────────────────────────────────

export const savedLocations = pgTable('saved_locations', {
  id:              uuid('id').primaryKey().defaultRandom(),
  ownerId:         uuid('owner_id').notNull(),
  clientRef:       text('client_ref'),
  kind:            text('kind').notNull(),
  category:        text('category'),
  name:            text('name').notNull(),
  description:     text('description').notNull().default(''),
  address:         text('address').notNull().default(''),
  lat:             doublePrecision('lat').notNull(),
  lng:             doublePrecision('lng').notNull(),
  geog:            geographyPoint('geog').notNull().generatedAlwaysAs(
    sql`extensions.st_setsrid(extensions.st_makepoint(lng, lat), 4326)::extensions.geography`),
  routePolyline:   text('route_polyline'),
  visibility:      text('visibility').notNull().default('private'),
  status:          text('status').notNull().default('active'),
  coverPhotoId:    uuid('cover_photo_id'),
  sourceJourneyId: uuid('source_journey_id'),
  createdAt:       timestamptz('created_at').notNull().defaultNow(),
  updatedAt:       timestamptz('updated_at').notNull().defaultNow(),
});

// ─── Media ──────────────────────────────────────────────────────────────────

export const photos = pgTable('photos', {
  id:          uuid('id').primaryKey().defaultRandom(),
  ownerId:     uuid('owner_id').notNull(),
  vehicleId:   uuid('vehicle_id'),
  journeyId:   uuid('journey_id'),
  locationId:  uuid('location_id'),
  bucket:      text('bucket').notNull(),
  storagePath: text('storage_path').notNull(),
  thumbPath:   text('thumb_path'),
  mimeType:    text('mime_type').notNull(),
  sizeBytes:   integer('size_bytes').notNull(),
  width:       integer('width'),
  height:      integer('height'),
  caption:     text('caption').notNull().default(''),
  sortOrder:   integer('sort_order').notNull().default(0),
  status:      text('status').notNull().default('pending'),
  createdAt:   timestamptz('created_at').notNull().defaultNow(),
  updatedAt:   timestamptz('updated_at').notNull().defaultNow(),
});

// ─── Notifications, push, reports ───────────────────────────────────────────

export const notifications = pgTable('notifications', {
  id:          uuid('id').primaryKey().defaultRandom(),
  userId:      uuid('user_id').notNull(),
  actorUserId: uuid('actor_user_id'),
  type:        text('type').notNull(),
  title:       text('title').notNull(),
  body:        text('body').notNull().default(''),
  data:        jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
  readAt:      timestamptz('read_at'),
  isRead:      boolean('is_read').notNull().generatedAlwaysAs(sql`(read_at is not null)`),
  createdAt:   timestamptz('created_at').notNull().defaultNow(),
});

export const pushDevices = pgTable('push_devices', {
  id:            uuid('id').primaryKey().defaultRandom(),
  userId:        uuid('user_id').notNull(),
  expoPushToken: text('expo_push_token').notNull(),
  platform:      text('platform').notNull(),
  appVersion:    text('app_version').notNull().default(''),
  enabled:       boolean('enabled').notNull().default(true),
  lastSeenAt:    timestamptz('last_seen_at').notNull().defaultNow(),
  createdAt:     timestamptz('created_at').notNull().defaultNow(),
  updatedAt:     timestamptz('updated_at').notNull().defaultNow(),
});

export const contentReports = pgTable('content_reports', {
  id:         uuid('id').primaryKey().defaultRandom(),
  reporterId: uuid('reporter_id'),
  targetType: text('target_type').notNull(),
  targetId:   uuid('target_id').notNull(),
  reason:     text('reason').notNull(),
  details:    text('details').notNull().default(''),
  status:     text('status').notNull().default('open'),
  createdAt:  timestamptz('created_at').notNull().defaultNow(),
  resolvedAt: timestamptz('resolved_at'),
});

// ─── Achievements ───────────────────────────────────────────────────────────

export const achievements = pgTable('achievements', {
  id:          text('id').primaryKey(),
  title:       text('title').notNull(),
  description: text('description').notNull(),
  icon:        text('icon').notNull(),
  xpReward:    integer('xp_reward').notNull().default(0),
  sortOrder:   integer('sort_order').notNull().default(0),
  isHidden:    boolean('is_hidden').notNull().default(false),
});

export const userAchievements = pgTable('user_achievements', {
  userId:          uuid('user_id').notNull(),
  achievementId:   text('achievement_id').notNull(),
  unlockedAt:      timestamptz('unlocked_at').notNull().defaultNow(),
  sourceJourneyId: uuid('source_journey_id'),
}, (t) => [primaryKey({ columns: [t.userId, t.achievementId] })]);
