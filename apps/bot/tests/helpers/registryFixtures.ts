// apps/bot/tests/helpers/registryFixtures.ts
import Database from "better-sqlite3";

export function inMemoryDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  return db;
}
