import { randomInt } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import type { Tx } from "./userDb";
import { publicUrl } from "./supabaseAdmin";

/** The small public card shown for another user in lists. */
export interface UserCard {
  id: string;
  username: string | null;
  displayName: string;
  avatarUrl: string | null;
  level: number;
}

/** SQL fragment selecting the card columns of profile alias `p`. */
export const cardColumns = sql.raw(
  `p.id as "id", p.username as "username", p.display_name as "displayName", p.avatar_path as "avatarPath", p.level as "level"`,
);

export function toCard(row: Record<string, unknown>): UserCard {
  return {
    id: String(row.id),
    username: (row.username as string | null) ?? null,
    displayName: String(row.displayName),
    avatarUrl: row.avatarPath ? publicUrl("avatars", String(row.avatarPath)) : null,
    level: Number(row.level),
  };
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

function newCode(length = 8): string {
  let s = "";
  for (let i = 0; i < length; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

/**
 * Creates (or replaces) the join code of a group or convoy. Join codes live in
 * the `private` schema so only the API can read them.
 */
export async function rotateJoinCode(tx: Tx, target: { groupId: string } | { convoyId: string }): Promise<string> {
  const column: SQL = "groupId" in target ? sql`group_id` : sql`convoy_id`;
  const id = "groupId" in target ? target.groupId : target.convoyId;
  await tx.execute(sql`delete from private.join_codes where ${column} = ${id}`);
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newCode();
    const r = await tx.execute(sql`
      insert into private.join_codes (code, ${column}) values (${code}, ${id})
      on conflict (code) do nothing returning code`);
    if (r.rows.length) return code;
  }
  throw new Error("could not allocate a unique join code");
}

export async function readJoinCode(tx: Tx, target: { groupId: string } | { convoyId: string }): Promise<string | null> {
  const column: SQL = "groupId" in target ? sql`group_id` : sql`convoy_id`;
  const id = "groupId" in target ? target.groupId : target.convoyId;
  const r = await tx.execute(sql`select code from private.join_codes where ${column} = ${id}`);
  return (r.rows[0] as { code: string } | undefined)?.code ?? null;
}

/** Normalises a user-typed code (case and spaces) before lookup. */
export const normaliseCode = (code: string) => code.replace(/\s+/g, "").toUpperCase();
export const CODE_PATTERN = /^[A-Za-z0-9 ]{6,16}$/;
