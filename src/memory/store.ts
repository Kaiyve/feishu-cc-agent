/**
 * 本地记忆 — SQLite（零配置）
 *
 * 数据库文件: ~/.feishu-cc-agent/memory.db
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
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      sender_open_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_sessions ON chat_sessions(chat_id, sender_open_id, created_at);

    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id TEXT NOT NULL,
      key TEXT NOT NULL,
      content TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'fact',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(owner_id, key)
    );
  `);
}

// ═══ 会话历史 ═══

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

  // 清理旧记录（保留 20 轮）
  const count = (db.prepare('SELECT COUNT(*) as c FROM chat_sessions WHERE chat_id = ? AND sender_open_id = ?').get(chatId, senderOpenId) as any)?.c || 0;
  if (count > 40) {
    db.prepare('DELETE FROM chat_sessions WHERE id IN (SELECT id FROM chat_sessions WHERE chat_id = ? AND sender_open_id = ? ORDER BY created_at ASC LIMIT ?)').run(chatId, senderOpenId, count - 40);
  }
}

// ═══ 长期记忆 ═══

export function searchMemories(query: string, chatId: string, senderOpenId: string): Array<{ key: string; content: string; type: string }> {
  if (!db) return [];
  const keywords = query.replace(/[?？！!。，,]/g, ' ').split(/\s+/).filter(w => w.length >= 2).slice(0, 5);
  if (keywords.length === 0) return [];

  const conditions = keywords.map(() => '(key LIKE ? OR content LIKE ?)').join(' OR ');
  const params = keywords.flatMap(k => [`%${k}%`, `%${k}%`]);

  return db.prepare(
    `SELECT key, content, type FROM memories
     WHERE (owner_id = ? OR owner_id = 'global') AND (${conditions})
     ORDER BY updated_at DESC LIMIT 10`
  ).all(senderOpenId, ...params) as any[];
}

export function saveMemory(key: string, content: string, type: string, ownerId: string) {
  if (!db) return;
  db.prepare(
    `INSERT INTO memories (owner_id, key, content, type) VALUES (?, ?, ?, ?)
     ON CONFLICT(owner_id, key) DO UPDATE SET content = excluded.content, type = excluded.type, updated_at = CURRENT_TIMESTAMP`
  ).run(ownerId, key, content, type);
}

export function deleteMemory(key: string, ownerId: string) {
  if (!db) return;
  db.prepare('DELETE FROM memories WHERE key = ? AND owner_id = ?').run(key, ownerId);
}
