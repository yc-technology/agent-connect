// apps/bot/tests/helpers/registryFixtures.ts
import { openDatabase, type SqliteDatabase } from "../../src/agent-connect/db.js";

export function inMemoryDb(): SqliteDatabase {
  const db = openDatabase(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA synchronous = NORMAL");
  return db;
}
