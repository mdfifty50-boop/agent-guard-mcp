/**
 * SQLite database layer for agent-guard-mcp.
 * DB path: ~/.agent-guard-mcp/guard.db
 * WAL mode enabled; rolling window capped at 50 rows per agent.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DB_DIR = join(homedir(), '.agent-guard-mcp');
const DB_PATH = join(DB_DIR, 'guard.db');

mkdirSync(DB_DIR, { recursive: true });

const db = new Database(DB_PATH);

// WAL mode for concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ═══════════════════════════════════════════
// SCHEMA
// ═══════════════════════════════════════════

db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    agent_id           TEXT PRIMARY KEY,
    max_iterations     INTEGER NOT NULL DEFAULT 100,
    progress_threshold REAL    NOT NULL DEFAULT 0.3,
    registered_at      TEXT    NOT NULL
  );

  CREATE TABLE IF NOT EXISTS action_logs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id       TEXT    NOT NULL,
    signature      TEXT    NOT NULL,
    tool_name      TEXT    NOT NULL,
    args_hash      TEXT    NOT NULL,
    result_preview TEXT    NOT NULL DEFAULT '',
    timestamp      TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_action_logs_agent_id
    ON action_logs (agent_id);

  CREATE TABLE IF NOT EXISTS circuit_breakers (
    agent_id   TEXT PRIMARY KEY,
    max_repeats INTEGER NOT NULL DEFAULT 3,
    action     TEXT    NOT NULL DEFAULT 'warn',
    created_at TEXT    NOT NULL
  );
`);

// ═══════════════════════════════════════════
// PREPARED STATEMENTS
// ═══════════════════════════════════════════

const stmts = {
  // agents
  upsertAgent: db.prepare(`
    INSERT INTO agents (agent_id, max_iterations, progress_threshold, registered_at)
    VALUES (@agent_id, @max_iterations, @progress_threshold, @registered_at)
    ON CONFLICT(agent_id) DO UPDATE SET
      max_iterations     = excluded.max_iterations,
      progress_threshold = excluded.progress_threshold,
      registered_at      = excluded.registered_at
  `),
  getAgent: db.prepare(`SELECT * FROM agents WHERE agent_id = ?`),
  listAgents: db.prepare(`SELECT * FROM agents`),

  // action_logs
  insertLog: db.prepare(`
    INSERT INTO action_logs (agent_id, signature, tool_name, args_hash, result_preview, timestamp)
    VALUES (@agent_id, @signature, @tool_name, @args_hash, @result_preview, @timestamp)
  `),
  countLogs: db.prepare(`SELECT COUNT(*) AS cnt FROM action_logs WHERE agent_id = ?`),
  getLogsAll: db.prepare(`SELECT * FROM action_logs WHERE agent_id = ? ORDER BY id ASC`),
  getLogsLast: db.prepare(`SELECT * FROM action_logs WHERE agent_id = ? ORDER BY id DESC LIMIT ?`),
  countSig: db.prepare(`SELECT COUNT(*) AS cnt FROM action_logs WHERE agent_id = ? AND signature = ?`),
  deleteOldest: db.prepare(`
    DELETE FROM action_logs
    WHERE id IN (
      SELECT id FROM action_logs
      WHERE agent_id = ?
      ORDER BY id ASC
      LIMIT ?
    )
  `),

  // circuit_breakers
  upsertBreaker: db.prepare(`
    INSERT INTO circuit_breakers (agent_id, max_repeats, action, created_at)
    VALUES (@agent_id, @max_repeats, @action, @created_at)
    ON CONFLICT(agent_id) DO UPDATE SET
      max_repeats = excluded.max_repeats,
      action      = excluded.action,
      created_at  = excluded.created_at
  `),
  getBreaker: db.prepare(`SELECT * FROM circuit_breakers WHERE agent_id = ?`),
};

// ═══════════════════════════════════════════
// ROLLING WINDOW ENFORCEMENT
// ═══════════════════════════════════════════

const ROLLING_WINDOW = 50;

function enforceRollingWindow(agentId) {
  const { cnt } = stmts.countLogs.get(agentId);
  if (cnt > ROLLING_WINDOW) {
    stmts.deleteOldest.run(agentId, cnt - ROLLING_WINDOW);
  }
}

export { db, stmts, enforceRollingWindow, ROLLING_WINDOW };
