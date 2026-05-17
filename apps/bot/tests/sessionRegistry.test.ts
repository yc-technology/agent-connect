import { describe, test, expect } from "vitest";
import { SessionRegistry } from "../src/agent-connect/sessionRegistry.js";
import { inMemoryDb } from "./helpers/registryFixtures.js";

describe("SessionRegistry schema", () => {
  test("creates all required tables on first open", () => {
    const db = inMemoryDb();
    new SessionRegistry(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("meta");
    expect(names).toContain("windows");
    expect(names).toContain("sessions");
    expect(names).toContain("thread_bindings");
    expect(names).toContain("user_window_offsets");
  });

  test("writes schema_version=1 into meta", () => {
    const db = inMemoryDb();
    new SessionRegistry(db);
    const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as
      | { value: string }
      | undefined;
    expect(row?.value).toBe("1");
  });
});
