import { DatabaseSync, type DatabaseSyncOptions } from "node:sqlite";

/**
 * SQLite via Node's built-in `node:sqlite` (DatabaseSync) instead of the native
 * `better-sqlite3` addon. Rationale: `better-sqlite3` is a NODE_MODULE_VERSION
 * (ABI)-bound native addon. The compiled binary matches whatever Node was
 * active at `npm install` time; if the user later switches Node (nvm) and runs
 * the already-installed daemon, the addon fails to load with
 * `ERR_DLOPEN_FAILED: NODE_MODULE_VERSION mismatch` and the service crash-loops.
 * `node:sqlite` ships inside the Node runtime itself, so it can never be out of
 * sync with the running Node — ABI mismatch is impossible by construction.
 *
 * This thin wrapper papers over the two better-sqlite3 conveniences node:sqlite
 * lacks: `db.pragma(...)` (use `db.exec("PRAGMA ...")`) and `db.transaction(fn)`
 * (see {@link dbTransaction}).
 */

// node:sqlite emits a one-time process `ExperimentalWarning` the first time a
// DatabaseSync is constructed. The subset we use (prepare/run/get/all/exec +
// savepoints) is stable, and the warning is pure noise on `pnpm dev` /
// foreground `agc start` (daemon mode discards child stderr so it never showed
// there). Filter ONLY that exact warning out of process.emit — every other
// warning, including any future non-SQLite ExperimentalWarning, passes through.
// Runs at module load, before openDatabase can construct anything.
function suppressSqliteExperimentalWarning(): void {
  const proc = process as NodeJS.Process & { __agcSqliteWarnFiltered?: boolean };
  if (proc.__agcSqliteWarnFiltered) return;
  proc.__agcSqliteWarnFiltered = true;
  const original = process.emit.bind(process);
  process.emit = ((event: string | symbol, ...args: unknown[]): boolean => {
    if (event === "warning") {
      const warning = args[0] as { name?: string; message?: string } | undefined;
      if (warning?.name === "ExperimentalWarning" && /sqlite/i.test(warning.message ?? "")) {
        return false;
      }
    }
    return (original as (event: string | symbol, ...a: unknown[]) => boolean)(event, ...args);
  }) as typeof process.emit;
}

suppressSqliteExperimentalWarning();

export type SqliteDatabase = DatabaseSync;

/**
 * Open (creating if absent) a database. Foreign keys default OFF to match
 * better-sqlite3's historical default — callers that need them (SessionRegistry)
 * enable them explicitly via `PRAGMA foreign_keys = ON`, and the legacy JSON
 * migration relies on FK being off so its import insert ordering stays tolerant.
 */
export function openDatabase(path: string, options: DatabaseSyncOptions = {}): DatabaseSync {
  return new DatabaseSync(path, { enableForeignKeyConstraints: false, ...options });
}

let savepointCounter = 0;

/**
 * Replacement for better-sqlite3's `db.transaction(fn)`. Returns a function that
 * runs `fn` atomically, rolling back on throw and re-raising the original error.
 * Mirrors the better-sqlite3 ergonomics (`const tx = dbTransaction(db, fn);
 * tx(args)`) so call sites barely change.
 *
 * Implemented with uniquely-named SAVEPOINTs rather than BEGIN/COMMIT so it
 * nests correctly — exactly like better-sqlite3, which also uses savepoints for
 * nested transactions. (The legacy JSON migration wraps the whole import in one
 * transaction and calls `registerSession`, which transacts again; a plain BEGIN
 * inside a BEGIN throws "cannot start a transaction within a transaction".) A
 * SAVEPOINT with no enclosing transaction opens one implicitly, so this works at
 * the outermost level too; the monotonic counter guarantees inner savepoints
 * never collide with outer ones.
 */
export function dbTransaction<A extends unknown[]>(
  db: DatabaseSync,
  fn: (...args: A) => void
): (...args: A) => void {
  return (...args: A) => {
    const name = `actx_${savepointCounter++}`;
    db.exec(`SAVEPOINT ${name}`);
    try {
      fn(...args);
      db.exec(`RELEASE ${name}`);
    } catch (error) {
      try {
        db.exec(`ROLLBACK TO ${name}`);
        db.exec(`RELEASE ${name}`);
      } catch {
        // Surface the original failure, not a secondary rollback error.
      }
      throw error;
    }
  };
}
