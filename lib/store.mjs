import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { cosineScore, normalizeVector } from "./embedding.mjs";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  embedding BLOB,
  dim INTEGER,
  tags TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'manual',
  session_id TEXT,
  cwd TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_memories_created_at ON memories(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source);
`;

export class MemoryStore {
  constructor(dbPath, logger = console) {
    this.dbPath = dbPath;
    this.logger = logger;
    this.ok = false;
    this.error = null;
    try {
      mkdirSync(dirname(dbPath), { recursive: true });
      this.db = new DatabaseSync(dbPath);
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec("PRAGMA busy_timeout = 5000;");
      this.db.exec(SCHEMA);
      // 旧库迁移:补 deleted_at 列(软删除/回收站)
      const columns = this.db.prepare("PRAGMA table_info(memories)").all().map((r) => r.name);
      if (!columns.includes("deleted_at")) {
        this.db.exec("ALTER TABLE memories ADD COLUMN deleted_at TEXT");
        logger?.info?.("[dsh-local-vector-memory] migrated: added deleted_at column");
      }
      this.ok = true;
      logger?.info?.(`[dsh-local-vector-memory] store ready: ${dbPath}`);
    } catch (error) {
      this.error = error;
      logger?.warn?.(
        `[dsh-local-vector-memory] store unavailable (${dbPath}): ${String(error?.message || error)}`,
      );
    }
  }

  assertOk() {
    if (!this.ok) {
      throw new Error(`memory store unavailable: ${String(this.error?.message || this.error || "unknown error")}`);
    }
  }

  normalizeTags(tags) {
    if (Array.isArray(tags)) {
      return [...new Set(tags.map((t) => String(t ?? "").trim()).filter(Boolean))].slice(0, 20);
    }
    if (typeof tags === "string" && tags.trim()) {
      return [
        ...new Set(
          tags
            .split(/[,，;；]/)
            .map((t) => t.trim())
            .filter(Boolean),
        ),
      ].slice(0, 20);
    }
    return [];
  }

  add(record) {
    this.assertOk();
    const text = String(record?.text ?? "").trim();
    if (!text) throw new Error("memory text is empty");
    const now = new Date().toISOString();
    const id = record.id || randomUUID();
    const vector = record.embedding ? normalizeVector(record.embedding) : null;
    const blob = vector ? vectorToBlob(vector) : null;
    this.db
      .prepare(
        `INSERT INTO memories
          (id, text, embedding, dim, tags, source, session_id, cwd, meta, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        text,
        blob,
        vector ? vector.length : null,
        JSON.stringify(this.normalizeTags(record.tags)),
        String(record.source || "manual"),
        record.sessionId ? String(record.sessionId) : null,
        record.cwd ? String(record.cwd) : null,
        JSON.stringify(record.meta && typeof record.meta === "object" ? record.meta : {}),
        now,
        now,
      );
    return this.get(id);
  }

  get(id) {
    this.assertOk();
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(String(id));
    return row ? rowToMemory(row) : null;
  }

  updateEmbedding(id, embedding) {
    this.assertOk();
    const vector = normalizeVector(embedding);
    const blob = vectorToBlob(vector);
    const result = this.db
      .prepare("UPDATE memories SET embedding = ?, dim = ?, updated_at = ? WHERE id = ?")
      .run(blob, vector.length, new Date().toISOString(), String(id));
    return result.changes > 0;
  }

  /** 默认软删除(deleted_at 标记,可 restore);soft=false 时硬删除。 */
  forget(id, { soft = true } = {}) {
    this.assertOk();
    if (soft) {
      const now = new Date().toISOString();
      const result = this.db
        .prepare("UPDATE memories SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
        .run(now, now, String(id));
      return result.changes > 0;
    }
    const result = this.db.prepare("DELETE FROM memories WHERE id = ?").run(String(id));
    return result.changes > 0;
  }

  /** 恢复软删除的记忆(回收站)。 */
  restore(id) {
    this.assertOk();
    const result = this.db
      .prepare("UPDATE memories SET deleted_at = NULL, updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), String(id));
    return result.changes > 0;
  }

  /** 更新已有记忆的文本/标签;文本变化时可传新向量(embedding 传 null 表示清空待重算)。 */
  update(id, { text, tags, embedding } = {}) {
    this.assertOk();
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(String(id));
    if (!row || row.deleted_at) return null;
    const nextText = text !== undefined && text !== null ? String(text).trim() : String(row.text);
    if (!nextText) throw new Error("memory text is empty");
    const nextTags = tags !== undefined && tags !== null ? this.normalizeTags(tags) : safeJsonArray(row.tags);
    let blob = row.embedding;
    let dim = row.dim;
    if (embedding !== undefined) {
      if (embedding === null) {
        blob = null;
        dim = null;
      } else {
        const vector = normalizeVector(embedding);
        blob = vectorToBlob(vector);
        dim = vector.length;
      }
    }
    this.db
      .prepare("UPDATE memories SET text = ?, tags = ?, embedding = ?, dim = ?, updated_at = ? WHERE id = ?")
      .run(nextText, JSON.stringify(nextTags), blob, dim, new Date().toISOString(), String(id));
    return this.get(id);
  }

  list({ limit = 20, tag = "", source = "", includeDeleted = false } = {}) {
    this.assertOk();
    const clauses = [];
    const params = [];
    if (!includeDeleted) clauses.push("deleted_at IS NULL");
    if (tag) {
      clauses.push("tags LIKE ?");
      params.push(`%"${escapeLike(String(tag))}"%`);
    }
    if (source) {
      clauses.push("source = ?");
      params.push(String(source));
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    params.push(clampInt(limit, 1, 200, 20));
    const rows = this.db
      .prepare(`SELECT * FROM memories ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params);
    return rows.map(rowToMemory);
  }

  /**
   * 语义检索 + 关键词兜底。返回 {vectorized, queryVector, results:[{...memory, score, match}]}
   * embedding 服务可用且存在向量时,优先返回向量结果;不足 limit 才用关键词补位。
   */
  search({ query, limit = 5, minScore = 0, keywordFallback = true, queryVector = null, tag = "" } = {}) {
    this.assertOk();
    const text = String(query ?? "").trim();
    if (!text) return { vectorized: false, queryVector: null, results: [] };
    const all = this.db
      .prepare("SELECT * FROM memories WHERE deleted_at IS NULL ORDER BY created_at DESC")
      .all()
      .filter((row) => {
        if (!tag) return true;
        return safeJsonArray(row.tags).includes(String(tag));
      });
    const results = [];
    const vector = queryVector ? normalizeVector(queryVector) : null;
    const vectorized = vector !== null;
    if (all.length > 0 && vector) {
      for (const row of all) {
        if (!row.embedding) continue;
        const memory = rowToMemory(row);
        const stored = blobToVector(row.embedding, row.dim);
        if (!stored) continue;
        const score = cosineScore(vector, stored);
        if (score >= minScore) {
          results.push({ ...memory, score: roundScore(score), match: "vector" });
        }
      }
      results.sort((a, b) => b.score - a.score);
    }
    if (keywordFallback && results.length < clampInt(limit, 1, 50, 5)) {
      const seen = new Set(results.map((r) => r.id));
      for (const row of all) {
        if (seen.has(row.id)) continue;
        const memory = rowToMemory(row);
        const score = keywordScore(memory.text, text);
        if (score > 0) {
          results.push({ ...memory, score: roundScore(score), match: "keyword" });
          seen.add(row.id);
        }
      }
      results.sort((a, b) => {
        if (a.match !== b.match) return a.match === "vector" ? -1 : 1;
        return b.score - a.score;
      });
    }
    return { vectorized, queryVector: vector, results: results.slice(0, clampInt(limit, 1, 50, 5)) };
  }

  missingVectorCandidates(limit = 100) {
    this.assertOk();
    const rows = this.db
      .prepare("SELECT * FROM memories WHERE embedding IS NULL AND deleted_at IS NULL ORDER BY created_at ASC LIMIT ?")
      .all(clampInt(limit, 1, 1000, 100));
    return rows.map(rowToMemory);
  }

  stats() {
    this.assertOk();
    const total = this.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE deleted_at IS NULL").get().n;
    const deleted = this.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE deleted_at IS NOT NULL").get().n;
    const vectorized = this.db
      .prepare("SELECT COUNT(*) AS n FROM memories WHERE embedding IS NOT NULL AND deleted_at IS NULL")
      .get().n;
    const bySource = this.db
      .prepare("SELECT source, COUNT(*) AS n FROM memories WHERE deleted_at IS NULL GROUP BY source ORDER BY n DESC")
      .all();
    const dims = this.db
      .prepare("SELECT DISTINCT dim FROM memories WHERE embedding IS NOT NULL AND deleted_at IS NULL")
      .all()
      .map((r) => r.dim)
      .filter(Boolean);
    return {
      total: Number(total),
      deleted: Number(deleted),
      vectorized: Number(vectorized),
      missingVectors: Number(total) - Number(vectorized),
      dimensions: dims.map(Number),
      sources: bySource.map((r) => ({ source: String(r.source), count: Number(r.n) })),
      dbPath: this.dbPath,
    };
  }

  /** SQLite 在线备份(VACUUM INTO 生成一致性快照,安全于手工 cp WAL 库)。 */
  backup(destPath) {
    this.assertOk();
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    this.db.exec(`VACUUM INTO '${String(destPath).replace(/'/g, "''")}'`);
    return destPath;
  }

  close() {
    try {
      this.db?.close();
    } catch {
      // ignore
    }
    this.ok = false;
  }
}

function rowToMemory(row) {
  return {
    id: String(row.id),
    text: String(row.text),
    dim: row.dim ? Number(row.dim) : null,
    tags: safeJsonArray(row.tags),
    source: String(row.source || "manual"),
    sessionId: row.session_id ? String(row.session_id) : null,
    cwd: row.cwd ? String(row.cwd) : null,
    meta: safeJsonObject(row.meta),
    createdAt: row.created_at ? String(row.created_at) : "",
    updatedAt: row.updated_at ? String(row.updated_at) : "",
    hasVector: row.embedding !== null,
    deletedAt: row.deleted_at ? String(row.deleted_at) : null,
  };
}

function vectorToBlob(vector) {
  const bytes = new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength);
  return Buffer.from(bytes);
}

function blobToVector(blob, expectedDim) {
  if (!blob) return null;
  const bytes = Uint8Array.from(blob);
  const dim = Number(expectedDim);
  if (!Number.isInteger(dim) || dim <= 0 || bytes.byteLength < dim * 4) return null;
  const copy = new Uint8Array(dim * 4);
  copy.set(bytes.subarray(0, dim * 4));
  return new Float32Array(copy.buffer);
}

function safeJsonArray(value) {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function safeJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function keywordScore(memoryText, query) {
  const text = String(memoryText || "").toLowerCase();
  const q = String(query || "").toLowerCase();
  const terms = new Set();
  for (const raw of q.split(/[^0-9a-z\u3400-\u9fff]+/i)) {
    if (raw.length >= 2) terms.add(raw);
  }
  // 中文整串切不出词时,用二元组近似
  const cjkRuns = q.match(/[\u3400-\u9fff]{2,}/g) || [];
  for (const run of cjkRuns) {
    if (run.length <= 4) terms.add(run);
    for (let i = 0; i + 2 <= run.length && run.length > 4; i += 1) terms.add(run.slice(i, i + 2));
  }
  if (terms.size === 0) return 0;
  let hits = 0;
  for (const term of terms) if (text.includes(term)) hits += 1;
  return hits / terms.size;
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function roundScore(score) {
  return Math.round(score * 10000) / 10000;
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
