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
  deleted_at TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  superseded_at TEXT,
  superseded_by TEXT
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
      if (!columns.includes("pinned")) {
        this.db.exec("ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
        logger?.info?.("[dsh-local-vector-memory] migrated: added pinned column");
      }
      if (!columns.includes("superseded_at")) {
        this.db.exec("ALTER TABLE memories ADD COLUMN superseded_at TEXT");
        this.db.exec("ALTER TABLE memories ADD COLUMN superseded_by TEXT");
        logger?.info?.("[dsh-local-vector-memory] migrated: added superseded_at/superseded_by columns");
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

  /** 标记旧记忆被新记忆取代(修正链),返回实际标记条数。 */
  supersede(ids, byId) {
    this.assertOk();
    const now = new Date().toISOString();
    let changed = 0;
    for (const id of ids) {
      const result = this.db
        .prepare(
          "UPDATE memories SET superseded_at = ?, superseded_by = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
        )
        .run(now, String(byId), now, String(id));
      changed += result.changes;
    }
    return changed;
  }

  /** 置顶核心记忆(会话首次召回时整体注入)。 */
  listPinned(limit = 20) {
    this.assertOk();
    const rows = this.db
      .prepare(
        "SELECT * FROM memories WHERE pinned = 1 AND deleted_at IS NULL AND superseded_at IS NULL ORDER BY updated_at DESC LIMIT ?",
      )
      .all(clampInt(limit, 1, 100, 20));
    return rows.map(rowToMemory);
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
  update(id, { text, tags, embedding, pinned } = {}) {
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
    const nextPinned = pinned !== undefined && pinned !== null ? (pinned ? 1 : 0) : Number(row.pinned);
    this.db
      .prepare("UPDATE memories SET text = ?, tags = ?, embedding = ?, dim = ?, pinned = ?, updated_at = ? WHERE id = ?")
      .run(nextText, JSON.stringify(nextTags), blob, dim, nextPinned, new Date().toISOString(), String(id));
    return this.get(id);
  }

  list({ limit = 20, tag = "", source = "", includeDeleted = false, includeSuperseded = false } = {}) {
    this.assertOk();
    const clauses = [];
    const params = [];
    if (!includeDeleted) clauses.push("deleted_at IS NULL");
    if (!includeSuperseded) clauses.push("superseded_at IS NULL");
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
    const limitN = clampInt(limit, 1, 50, 5);
    const all = this.db
      .prepare("SELECT * FROM memories WHERE deleted_at IS NULL AND superseded_at IS NULL ORDER BY created_at DESC")
      .all()
      .filter((row) => {
        if (!tag) return true;
        return safeJsonArray(row.tags).includes(String(tag));
      });
    const vector = queryVector ? normalizeVector(queryVector) : null;
    const vectorized = vector !== null;
    const vecHits = [];
    if (vector) {
      for (const row of all) {
        if (!row.embedding) continue;
        const stored = blobToVector(row.embedding, row.dim);
        if (!stored) continue;
        const score = cosineScore(vector, stored);
        if (score >= minScore) {
          vecHits.push({ ...rowToMemory(row), vecScore: roundScore(score) });
        }
      }
      vecHits.sort((a, b) => b.vecScore - a.vecScore);
    }
    const kwHits = [];
    if (keywordFallback) {
      for (const row of all) {
        const memory = rowToMemory(row);
        const score = keywordScore(memory.text, text);
        if (score > 0) kwHits.push({ ...memory, kwScore: roundScore(score) });
      }
      kwHits.sort((a, b) => b.kwScore - a.kwScore);
    }
    // RRF 融合:双信号按 1/(k+rank) 融合排序;单信号时纯按原分数
    const results = [];
    const k = 60;
    if (vecHits.length > 0 && kwHits.length > 0) {
      vecHits.forEach((hit, i) => { hit.rrfPart = 1 / (k + i + 1); });
      kwHits.forEach((hit, i) => { hit.rrfPart = 1 / (k + i + 1); });
      for (const hit of vecHits) {
        const kw = kwHits.find((x) => x.id === hit.id);
        const rrf = hit.rrfPart + (kw ? kw.rrfPart : 0);
        results.push({ ...hit, kwScore: kw ? kw.kwScore : null, score: roundScore(rrf), match: "rrf" });
      }
      for (const hit of kwHits) {
        if (vecHits.some((x) => x.id === hit.id)) continue;
        results.push({ ...hit, score: roundScore(hit.rrfPart), match: "rrf" });
      }
      results.sort((a, b) => b.score - a.score);
    } else if (vecHits.length > 0) {
      for (const hit of vecHits) results.push({ ...hit, score: hit.vecScore, match: "vector" });
    } else if (kwHits.length > 0) {
      for (const hit of kwHits) results.push({ ...hit, score: hit.kwScore, match: "keyword" });
    }
    return { vectorized, queryVector: vector, results: results.slice(0, limitN) };
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
    const pinned = this.db
      .prepare("SELECT COUNT(*) AS n FROM memories WHERE pinned = 1 AND deleted_at IS NULL AND superseded_at IS NULL")
      .get().n;
    const superseded = this.db
      .prepare("SELECT COUNT(*) AS n FROM memories WHERE superseded_at IS NOT NULL AND deleted_at IS NULL")
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
      pinned: Number(pinned),
      superseded: Number(superseded),
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
    pinned: Number(row.pinned) === 1,
    supersededAt: row.superseded_at ? String(row.superseded_at) : null,
    supersededBy: row.superseded_by ? String(row.superseded_by) : null,
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
