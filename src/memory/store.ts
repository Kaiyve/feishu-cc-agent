/**
 * Memory System — SQLite + FTS5 (zero config)
 *
 * Three layers:
 *   1. Session history — recent conversation turns (per chat+user)
 *   2. Long-term memories — auto-extracted facts/preferences (FTS5 searchable)
 *   3. Session summaries — compressed old conversations (searchable context)
 *
 * DB file: ~/.feishu-cc-agent/memory.db
 */

import Database from 'better-sqlite3';
import { resolve } from 'path';
import { homedir } from 'os';
import { mkdirSync, existsSync } from 'fs';

const DB_DIR = resolve(homedir(), '.feishu-cc-agent');
const DB_PATH = resolve(DB_DIR, 'memory.db');

let db: Database.Database | null = null;

export function initMemory() {
  if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    -- Session history (recent turns)
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      sender_open_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_sessions ON chat_sessions(chat_id, sender_open_id, created_at);

    -- Long-term memories (facts, preferences, insights)
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id TEXT NOT NULL,
      key TEXT NOT NULL,
      content TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'fact',
      source TEXT NOT NULL DEFAULT 'manual',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(owner_id, key)
    );

    -- Session summaries (compressed old conversations)
    CREATE TABLE IF NOT EXISTS session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      sender_open_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      turn_count INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_summaries ON session_summaries(chat_id, sender_open_id, created_at);
  `);

  // FTS5 for memories — enables full-text search instead of LIKE
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        key, content, owner_id UNINDEXED,
        content=memories, content_rowid=id,
        tokenize='unicode61'
      );
    `);
    // Sync triggers: keep FTS in sync with memories table
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, key, content, owner_id) VALUES (new.id, new.key, new.content, new.owner_id);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, key, content, owner_id) VALUES ('delete', old.id, old.key, old.content, old.owner_id);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, key, content, owner_id) VALUES ('delete', old.id, old.key, old.content, old.owner_id);
        INSERT INTO memories_fts(rowid, key, content, owner_id) VALUES (new.id, new.key, new.content, new.owner_id);
      END;
    `);
  } catch {
    // FTS5 triggers may already exist — safe to ignore
  }

  // Rebuild FTS index from existing data (idempotent)
  try {
    const ftsCount = (db.prepare(`SELECT COUNT(*) as c FROM memories_fts`).get() as any)?.c || 0;
    const memCount = (db.prepare(`SELECT COUNT(*) as c FROM memories`).get() as any)?.c || 0;
    if (memCount > 0 && ftsCount === 0) {
      db.exec(`INSERT INTO memories_fts(rowid, key, content, owner_id) SELECT id, key, content, owner_id FROM memories`);
    }
  } catch { /* first run, no data */ }
}

// ═══ Session History ═══

export function loadHistory(chatId: string, senderOpenId: string, limit = 10): Array<{ role: string; content: string }> {
  if (!db) return [];
  const rows = db.prepare(
    `SELECT role, content FROM chat_sessions
     WHERE chat_id = ? AND sender_open_id = ?
     ORDER BY created_at DESC LIMIT ?`
  ).all(chatId, senderOpenId, limit * 2) as any[];
  return rows.reverse();
}

export function saveHistory(chatId: string, senderOpenId: string, userMsg: string, assistantMsg: string) {
  if (!db) return;
  const ins = db.prepare('INSERT INTO chat_sessions (chat_id, sender_open_id, role, content) VALUES (?, ?, ?, ?)');
  ins.run(chatId, senderOpenId, 'user', userMsg.slice(0, 2000));
  ins.run(chatId, senderOpenId, 'assistant', assistantMsg.slice(0, 2000));
}

/**
 * Get old turns that should be compressed into a summary.
 * Returns turns older than the most recent `keepRecent` turns.
 */
export function getOldTurns(chatId: string, senderOpenId: string, keepRecent = 20): Array<{ id: number; role: string; content: string }> {
  if (!db) return [];
  const total = (db.prepare('SELECT COUNT(*) as c FROM chat_sessions WHERE chat_id = ? AND sender_open_id = ?').get(chatId, senderOpenId) as any)?.c || 0;
  if (total <= keepRecent) return [];

  const excess = total - keepRecent;
  return db.prepare(
    `SELECT id, role, content FROM chat_sessions
     WHERE chat_id = ? AND sender_open_id = ?
     ORDER BY created_at ASC LIMIT ?`
  ).all(chatId, senderOpenId, excess) as any[];
}

/**
 * Delete old turns after they've been summarized.
 */
export function deleteOldTurns(ids: number[]) {
  if (!db || ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM chat_sessions WHERE id IN (${placeholders})`).run(...ids);
}

// ═══ Session Summaries ═══

export function saveSummary(chatId: string, senderOpenId: string, summary: string, turnCount: number) {
  if (!db) return;
  db.prepare(
    'INSERT INTO session_summaries (chat_id, sender_open_id, summary, turn_count) VALUES (?, ?, ?, ?)'
  ).run(chatId, senderOpenId, summary.slice(0, 4000), turnCount);
}

export function loadSummaries(chatId: string, senderOpenId: string, limit = 3): Array<{ summary: string; created_at: string }> {
  if (!db) return [];
  return db.prepare(
    `SELECT summary, created_at FROM session_summaries
     WHERE chat_id = ? AND sender_open_id = ?
     ORDER BY created_at DESC LIMIT ?`
  ).all(chatId, senderOpenId, limit) as any[];
}

// ═══ Long-term Memories (FTS5 + Temporal Decay) ═══

/**
 * Search memories using FTS5 full-text search with temporal decay scoring.
 * Falls back to LIKE if FTS5 query fails (e.g. special characters).
 */
export function searchMemories(query: string, _chatId: string, senderOpenId: string): Array<{ key: string; content: string; type: string; score: number }> {
  if (!db) return [];

  // Try FTS5 first
  const ftsResults = searchFTS(query, senderOpenId);
  if (ftsResults.length > 0) return ftsResults;

  // Fallback: keyword LIKE search
  return searchLike(query, senderOpenId);
}

function searchFTS(query: string, ownerId: string): Array<{ key: string; content: string; type: string; score: number }> {
  if (!db) return [];

  // Build FTS5 query: split into tokens, join with OR
  const tokens = query
    .replace(/[?？！!。，,、：:；;""''（）()【】\[\]{}]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2)
    .slice(0, 8);
  if (tokens.length === 0) return [];

  const ftsQuery = tokens.map(t => `"${t}"`).join(' OR ');

  try {
    const rows = db!.prepare(`
      SELECT m.key, m.content, m.type, m.updated_at,
             rank AS fts_rank
      FROM memories_fts f
      JOIN memories m ON m.id = f.rowid
      WHERE memories_fts MATCH ?
        AND (m.owner_id = ? OR m.owner_id = 'global')
      ORDER BY rank
      LIMIT 15
    `).all(ftsQuery, ownerId) as any[];

    // Apply temporal decay: newer memories score higher
    const now = Date.now();
    return rows.map(r => {
      const ageMs = now - new Date(r.updated_at).getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      const decay = Math.exp(-0.023 * ageDays); // half-life ≈ 30 days
      const relevance = 1 / (1 + Math.abs(r.fts_rank));
      return {
        key: r.key,
        content: r.content,
        type: r.type,
        score: relevance * decay,
      };
    }).sort((a, b) => b.score - a.score).slice(0, 10);
  } catch {
    return []; // FTS query syntax error → fall back to LIKE
  }
}

function searchLike(query: string, ownerId: string): Array<{ key: string; content: string; type: string; score: number }> {
  if (!db) return [];
  const keywords = query
    .replace(/[?？！!。，,]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2)
    .slice(0, 5);
  if (keywords.length === 0) return [];

  const conditions = keywords.map(() => '(key LIKE ? OR content LIKE ?)').join(' OR ');
  const params = keywords.flatMap(k => [`%${k}%`, `%${k}%`]);

  const rows = db.prepare(
    `SELECT key, content, type, updated_at FROM memories
     WHERE (owner_id = ? OR owner_id = 'global') AND (${conditions})
     ORDER BY updated_at DESC LIMIT 10`
  ).all(ownerId, ...params) as any[];

  const now = Date.now();
  return rows.map(r => {
    const ageMs = now - new Date(r.updated_at).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    const decay = Math.exp(-0.023 * ageDays);
    return { key: r.key, content: r.content, type: r.type, score: decay };
  });
}

/**
 * Get all recent memories (regardless of query match) for context injection.
 * Returns the N most recently updated memories for this user.
 */
export function getRecentMemories(senderOpenId: string, limit = 5): Array<{ key: string; content: string; type: string }> {
  if (!db) return [];
  return db.prepare(
    `SELECT key, content, type FROM memories
     WHERE owner_id = ? OR owner_id = 'global'
     ORDER BY updated_at DESC LIMIT ?`
  ).all(senderOpenId, limit) as any[];
}

export function saveMemory(key: string, content: string, type: string, ownerId: string, source = 'manual') {
  if (!db) return;
  db.prepare(
    `INSERT INTO memories (owner_id, key, content, type, source) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(owner_id, key) DO UPDATE SET
       content = excluded.content,
       type = excluded.type,
       source = excluded.source,
       updated_at = CURRENT_TIMESTAMP`
  ).run(ownerId, key, content, type, source);
}

export function deleteMemory(key: string, ownerId: string) {
  if (!db) return;
  db.prepare('DELETE FROM memories WHERE key = ? AND owner_id = ?').run(key, ownerId);
}

export function getMemoryCount(ownerId: string): number {
  if (!db) return 0;
  return (db.prepare('SELECT COUNT(*) as c FROM memories WHERE owner_id = ? OR owner_id = \'global\'').get(ownerId) as any)?.c || 0;
}
