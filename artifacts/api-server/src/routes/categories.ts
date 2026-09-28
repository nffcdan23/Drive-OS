import { Router } from "express";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import { db, journeyCategories } from "@workspace/db";
import { requireUser } from "../middleware/auth";
import { handler, notFound, uuidParam } from "../lib/http";
import { Body } from "../lib/validate";

const router = Router();
const COLOUR = /^#[0-9A-Fa-f]{6}$/;

// GET /api/categories — shared defaults plus the user's own
router.get("/categories", requireUser, handler(async (req, res) => {
  const rows = await db.select().from(journeyCategories)
    .where(or(isNull(journeyCategories.ownerId), eq(journeyCategories.ownerId, req.userId)))
    .orderBy(asc(journeyCategories.sortOrder), asc(journeyCategories.createdAt));
  res.json(rows);
}));

// POST /api/categories
router.post("/categories", requireUser, handler(async (req, res) => {
  const b = Body.of(req);
  const [row] = await db.insert(journeyCategories).values({
    ownerId: req.userId,
    name: b.str("name", { min: 1, max: 40 })!,
    icon: b.str("icon", { min: 1, max: 40 })!,
    colour: b.str("colour", { pattern: COLOUR })!,
    sortOrder: b.int("sortOrder", { optional: true, min: 0, max: 10_000 }) ?? 100,
  }).returning();
  res.status(201).json(row);
}));

// PATCH /api/categories/:id — own categories only (defaults are read-only)
router.patch("/categories/:id", requireUser, handler(async (req, res) => {
  const b = Body.of(req);
  const u: Partial<typeof journeyCategories.$inferInsert> = {};
  if (b.has("name")) u.name = b.str("name", { min: 1, max: 40 })!;
  if (b.has("icon")) u.icon = b.str("icon", { min: 1, max: 40 })!;
  if (b.has("colour")) u.colour = b.str("colour", { pattern: COLOUR })!;
  if (b.has("sortOrder")) u.sortOrder = b.int("sortOrder", { min: 0, max: 10_000 })!;
  const [row] = await db.update(journeyCategories).set(u)
    .where(and(eq(journeyCategories.id, uuidParam(req, "id")), eq(journeyCategories.ownerId, req.userId))).returning();
  if (!row) throw notFound();
  res.json(row);
}));

// DELETE /api/categories/:id — journeys using it become uncategorised
router.delete("/categories/:id", requireUser, handler(async (req, res) => {
  const [row] = await db.delete(journeyCategories)
    .where(and(eq(journeyCategories.id, uuidParam(req, "id")), eq(journeyCategories.ownerId, req.userId)))
    .returning({ id: journeyCategories.id });
  if (!row) throw notFound();
  res.status(204).send();
}));

export default router;
