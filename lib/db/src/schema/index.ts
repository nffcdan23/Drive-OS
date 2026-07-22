import {
  pgTable, uuid, text, integer, real, boolean, timestamp, jsonb, primaryKey,
} from 'drizzle-orm/pg-core';

// ─── Users ────────────────────────────────────────────────────────────────────

export const users = pgTable('users', {
  id:            uuid('id').primaryKey().defaultRandom(),
  deviceId:      text('device_id').notNull().unique(),
  name:          text('name').notNull().default('Driver'),
  username:      text('username'),
  bio:           text('bio'),
  friendCode:    text('friend_code'),
  unitSystem:    text('unit_system').notNull().default('auto'),
  level:         integer('level').notNull().default(1),
  xp:            integer('xp').notNull().default(0),
  xpToNextLevel: integer('xp_to_next_level').notNull().default(1000),
  totalDistance: real('total_distance').notNull().default(0),
  totalJourneys: integer('total_journeys').notNull().default(0),
  createdAt:     timestamp('created_at').defaultNow().notNull(),
  updatedAt:     timestamp('updated_at').defaultNow().notNull(),
});

export type DbUser = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

// ─── Vehicles ─────────────────────────────────────────────────────────────────

export const vehicles = pgTable('vehicles', {
  id:           uuid('id').primaryKey().defaultRandom(),
  userId:       uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  nickname:     text('nickname').notNull(),
  registration: text('registration').notNull().default(''),
  make:         text('make').notNull(),
  model:        text('model').notNull(),
  year:         integer('year').notNull(),
  colour:       text('colour').notNull().default(''),
  fuelType:     text('fuel_type').notNull().default('petrol'),
  engine:       text('engine').notNull().default(''),
  power:        text('power').notNull().default(''),
  torque:       text('torque').notNull().default(''),
  zeroToSixty:  text('zero_to_sixty').notNull().default(''),
  topSpeedSpec: text('top_speed_spec').notNull().default(''),
  mileage:      integer('mileage').notNull().default(0),
  imageUrl:     text('image_url'),
  isActive:     boolean('is_active').notNull().default(false),
  createdAt:    timestamp('created_at').defaultNow().notNull(),
  updatedAt:    timestamp('updated_at').defaultNow().notNull(),
});

export type DbVehicle = typeof vehicles.$inferSelect;
export type InsertVehicle = typeof vehicles.$inferInsert;

// ─── Journey Categories ───────────────────────────────────────────────────────

export const journeyCategories = pgTable('journey_categories', {
  id:        uuid('id').primaryKey().defaultRandom(),
  userId:    uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  name:      text('name').notNull(),
  icon:      text('icon').notNull(),
  colour:    text('colour').notNull(),
  isDefault: boolean('is_default').notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export type DbJourneyCategory = typeof journeyCategories.$inferSelect;
export type InsertJourneyCategory = typeof journeyCategories.$inferInsert;

// ─── Journeys ─────────────────────────────────────────────────────────────────

export const journeys = pgTable('journeys', {
  id:              uuid('id').primaryKey().defaultRandom(),
  userId:          uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  vehicleId:       uuid('vehicle_id').references(() => vehicles.id, { onDelete: 'set null' }),
  name:            text('name').notNull().default('Unnamed Journey'),
  date:            text('date').notNull(),
  startTimeIso:    text('start_time_iso').notNull(),
  endTimeIso:      text('end_time_iso'),
  durationSeconds: integer('duration_seconds').notNull().default(0),
  distanceKm:      real('distance_km').notNull().default(0),
  avgSpeedKmh:     real('avg_speed_kmh').notNull().default(0),
  topSpeedKmh:     real('top_speed_kmh').notNull().default(0),
  notes:           text('notes').notNull().default(''),
  photos:          jsonb('photos').$type<string[]>().notNull().default([]),
  categoryId:      uuid('category_id').references(() => journeyCategories.id, { onDelete: 'set null' }),
  journeyType:     text('journey_type').notNull().default('personal'),
  xpEarned:        integer('xp_earned').notNull().default(0),
  privacy:         text('privacy').notNull().default('private'),
  convoyId:        uuid('convoy_id'),
  vehicleSnapshot: jsonb('vehicle_snapshot'),
  // 'active' while drive is in progress, 'completed' after endDrive succeeds
  status:          text('status').notNull().default('completed'),
  createdAt:       timestamp('created_at').defaultNow().notNull(),
  updatedAt:       timestamp('updated_at').defaultNow().notNull(),
});

export type DbJourney = typeof journeys.$inferSelect;
export type InsertJourney = typeof journeys.$inferInsert;

// ─── Journey Route Points ─────────────────────────────────────────────────────

export const journeyRoutePoints = pgTable('journey_route_points', {
  id:         uuid('id').primaryKey().defaultRandom(),
  journeyId:  uuid('journey_id').notNull().references(() => journeys.id, { onDelete: 'cascade' }),
  latitude:   real('latitude').notNull(),
  longitude:  real('longitude').notNull(),
  speedKmh:   real('speed_kmh').notNull().default(0),
  accuracyM:  real('accuracy_m'),
  recordedAt: timestamp('recorded_at').notNull(),
});

export type DbJourneyRoutePoint = typeof journeyRoutePoints.$inferSelect;
export type InsertJourneyRoutePoint = typeof journeyRoutePoints.$inferInsert;

// ─── Achievements ─────────────────────────────────────────────────────────────

export const achievements = pgTable('achievements', {
  id:          text('id').primaryKey(),
  title:       text('title').notNull(),
  description: text('description').notNull(),
  icon:        text('icon').notNull(),
});

export type DbAchievement = typeof achievements.$inferSelect;

// ─── User Achievements ────────────────────────────────────────────────────────

export const userAchievements = pgTable('user_achievements', {
  userId:        uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  achievementId: text('achievement_id').notNull().references(() => achievements.id, { onDelete: 'cascade' }),
  unlockedAt:    timestamp('unlocked_at').defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.achievementId] }),
}));

// ─── Friendships ──────────────────────────────────────────────────────────────

export const friendships = pgTable('friendships', {
  userId:    uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  friendId:  uuid('friend_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.friendId] }),
}));

// ─── Friend Requests ──────────────────────────────────────────────────────────

export const friendRequests = pgTable('friend_requests', {
  id:             uuid('id').primaryKey().defaultRandom(),
  fromId:         uuid('from_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  toFriendCode:   text('to_friend_code').notNull(),
  status:         text('status').notNull().default('pending'), // pending | accepted | declined
  createdAt:      timestamp('created_at').defaultNow().notNull(),
});

// ─── Convoys ──────────────────────────────────────────────────────────────────

export const convoys = pgTable('convoys', {
  id:              uuid('id').primaryKey().defaultRandom(),
  ownerId:         uuid('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name:            text('name').notNull(),
  destination:     text('destination').notNull().default(''),
  isPrivate:       boolean('is_private').notNull().default(false),
  startTime:       text('start_time').notNull(),
  status:          text('status').notNull().default('forming'),
  description:     text('description').notNull().default(''),
  maxParticipants: integer('max_participants'),
  createdAt:       timestamp('created_at').defaultNow().notNull(),
});

// ─── Convoy Participants ──────────────────────────────────────────────────────

export const convoyParticipants = pgTable('convoy_participants', {
  convoyId: uuid('convoy_id').notNull().references(() => convoys.id, { onDelete: 'cascade' }),
  userId:   uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  joinedAt: timestamp('joined_at').defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.convoyId, t.userId] }),
}));

// ─── Groups ───────────────────────────────────────────────────────────────────

export const groups = pgTable('groups', {
  id:               uuid('id').primaryKey().defaultRandom(),
  ownerId:          uuid('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name:             text('name').notNull(),
  description:      text('description').notNull().default(''),
  logoUrl:          text('logo_url'),
  isPublic:         boolean('is_public').notNull().default(true),
  membershipMethod: text('membership_method').notNull().default('open'),
  primaryLocation:  text('primary_location').notNull().default(''),
  vehicleInterests: text('vehicle_interests').notNull().default(''),
  createdAt:        timestamp('created_at').defaultNow().notNull(),
});

// ─── Group Members ────────────────────────────────────────────────────────────

export const groupMembers = pgTable('group_members', {
  groupId:  uuid('group_id').notNull().references(() => groups.id, { onDelete: 'cascade' }),
  userId:   uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role:     text('role').notNull().default('member'),
  joinedAt: timestamp('joined_at').defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.groupId, t.userId] }),
}));

// ─── Events ───────────────────────────────────────────────────────────────────

export const events = pgTable('events', {
  id:              uuid('id').primaryKey().defaultRandom(),
  organiserId:     uuid('organiser_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  groupId:         uuid('group_id').references(() => groups.id, { onDelete: 'set null' }),
  name:            text('name').notNull(),
  description:     text('description').notNull().default(''),
  coverUrl:        text('cover_url'),
  location:        text('location').notNull().default(''),
  date:            text('date').notNull(),
  startTime:       text('start_time').notNull(),
  endTime:         text('end_time').notNull(),
  eventType:       text('event_type').notNull().default('other'),
  isPublic:        boolean('is_public').notNull().default(true),
  capacity:        integer('capacity').notNull().default(0),
  entryCost:       text('entry_cost').notNull().default('Free'),
  vehicleCategory: text('vehicle_category').notNull().default('All'),
  createdAt:       timestamp('created_at').defaultNow().notNull(),
});

// ─── Event RSVPs ──────────────────────────────────────────────────────────────

export const eventRsvps = pgTable('event_rsvps', {
  eventId:   uuid('event_id').notNull().references(() => events.id, { onDelete: 'cascade' }),
  userId:    uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  status:    text('status').notNull(), // going | interested | declined
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.eventId, t.userId] }),
}));

// ─── Notifications ────────────────────────────────────────────────────────────

export const notifications = pgTable('notifications', {
  id:        uuid('id').primaryKey().defaultRandom(),
  userId:    uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  type:      text('type').notNull(),
  title:     text('title').notNull(),
  body:      text('body').notNull(),
  read:      boolean('read').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export type DbNotification = typeof notifications.$inferSelect;
