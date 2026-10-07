import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type Db = DatabaseSync;

const SCHEMA_URL = new URL("./db/schema.sql", import.meta.url);

/**
 * Open (and migrate) the SQLite database.
 * `location` is either ":memory:" or a data directory (the file `later.db` is created inside it).
 */
export function openDb(location: string): Db {
  let file = location;
  if (location !== ":memory:") {
    mkdirSync(location, { recursive: true });
    file = join(location, "later.db");
    mkdirSync(dirname(file), { recursive: true });
  }
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(readFileSync(SCHEMA_URL, "utf8"));
  return db;
}

/** Run `fn` inside a transaction (synchronous; nested calls reuse the outer transaction). */
export function tx<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
