import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { loadCreateUserMessage } from "./peers.mjs";
import { PLUGIN_SOURCE } from "./config.mjs";
import { buildTranscript, extractMemoriesWithLlm } from "./extract.mjs";

export class LocalMemoryRuntime {
  constructor(cfg, store, embeddings, logger = console) {
    this.cfg = cfg;
    this.store = store;
    this.embeddings = embeddings;
    this.logger = logger;
    this.states = new Map();
    try {
      this.autoCaptureRe = new RegExp(cfg.autoCaptureCues, "i");
    } catch {
      this.autoCaptureRe = /记住|以后|偏好|约定|决定|配置|环境/;
    }
  }

  stateFor(session) {
    let state = this.states.get(session?.id);
    if (state) return state;
    state = {
      id: String(session?.id || "unknown"),
      cwd: String(session?.header?.cwd || session?.cwd || ""),
      entries: [],
      totalChars: 0,
      recallHashes: [],
      flushPromise: null,
      captureQueue: Promise.resolve(),
    };
    this.states.set(state.id, state);
    return state;
  }

  capture(session, event) {
    if (!event || typeof event !== "object") return;
    const state = this.stateFor(session);
    const text = extractEventText(event);
    if (!text) return;
    if (state.totalChars >= this.cfg.captureMaxChars) return;
    const clipped = text.length + state.totalChars > this.cfg.captureMaxChars
      ? text.slice(0, Math.max(0, this.cfg.captureMaxChars - state.totalChars))
      : text;
    if (!clipped.trim()) return;
    const role = eventRole(event);
    state.entries.push({ role, text: clipped, time: Date.now() });
    state.totalChars += clipped.length;
    if (
      role === "user"
      && this.cfg.autoCapture
      && clipped.length >= this.cfg.autoCaptureMinChars
      && clipped.length <= this.cfg.autoCaptureMaxChars
      && this.autoCaptureRe.test(clipped)
    ) {
      state.captureQueue = state.captureQueue
        .then(() => this.autoCapture(state, clipped))
        .catch((error) => {
          this.logger?.debug?.(`[dsh-local-vector-memory] auto capture failed: ${String(error?.message || error)}`);
        });
    }
  }

  async autoCapture(state, text) {
    if (!this.store.ok) return null;
    const clean = cleanAutoCaptureText(text, this.cfg.autoCaptureMaxChars);
    if (clean.length < this.cfg.autoCaptureMinChars) return null;
    let embedding = null;
    try {
      embedding = await this.embeddings.embedOne(clean);
    } catch (error) {
      this.logger?.debug?.(`[dsh-local-vector-memory] auto capture embed failed: ${String(error?.message || error)}`);
    }
    const duplicate = await this.findSimilar(clean, embedding, this.cfg.extractionDedupScore);
    if (duplicate) return null;
    try {
      const record = this.store.add({
        text: clean,
        embedding,
        tags: ["自动捕获"],
        source: "auto-capture",
        sessionId: state.id,
        cwd: state.cwd,
        meta: { method: "cue" },
      });
      this.logger?.info?.(`[dsh-local-vector-memory] auto-captured ${record.id}: ${clipText(clean, 120)}`);
      return record;
    } catch (error) {
      this.logger?.warn?.(`[dsh-local-vector-memory] auto capture store failed: ${String(error?.message || error)}`);
      return null;
    }
  }

  async recallMessage(agent, messages, signal) {
    try {
      if (!this.cfg.autoRecall || !this.store.ok) return null;
      const state = this.stateFor(agent?.session);
      const query = userQuery(messages, this.cfg.recallMaxQueryChars);
      if (query.length < this.cfg.recallMinQueryLength) return null;
      const hash = quickHash(query);
      if (this.cfg.recallDedupePerSession) {
        if (state.recallHashes.includes(hash)) return null;
        state.recallHashes.push(hash);
        const lru = this.cfg.recallDedupeLru ?? 16;
        while (state.recallHashes.length > lru) state.recallHashes.shift();
      }

      const result = await this.searchMemories(query, this.cfg.recallTopK, signal);
      const hits = (result.results || []).filter(
        (r) => r.score >= this.cfg.recallMinScore && r.match === "vector",
      );
      if (hits.length === 0) return null;

      const lines = hits.map((r) => {
        const preview = clipText(r.text, this.cfg.displayMaxChars);
        return `- [${r.match} ${r.score.toFixed(3)}] ${preview}`;
      });
      const content = [
        `<local-memory source="recall">`,
        "本地向量记忆检索到以下相关长期记忆(已注入上下文,若与当前任务无关请忽略,不要逐字复述):",
        ...lines,
        "</local-memory>",
      ].join("\n");
      const createUserMessage = await loadCreateUserMessage();
      return createUserMessage({
        content: [{ type: "text", text: content }],
        source: { kind: "plugin", plugin: PLUGIN_SOURCE, form: "recall" },
      });
    } catch (error) {
      this.logger?.debug?.(`[dsh-local-vector-memory] recall skipped: ${String(error?.message || error)}`);
      return null;
    }
  }

  async flush(session) {
    const state = this.stateFor(session);
    if (state.captureQueue) await state.captureQueue;
    if (state.flushPromise) await state.flushPromise;
    if (this.cfg.autoExtract && this.store.ok) {
      state.flushPromise = this.extractFromTranscript(state).finally(() => {
        state.flushPromise = null;
      });
      await state.flushPromise;
    }
    this.states.delete(state.id);
  }

  async extractFromTranscript(state) {
    try {
      const transcript = buildTranscript(state.entries, this.cfg.extractionTranscriptChars);
      if (transcript.length < this.cfg.extractionMinChars) {
        this.logger?.debug?.(
          `[dsh-local-vector-memory] transcript too short for extraction (${transcript.length} chars)`,
        );
        return { extracted: 0, added: 0, skipped: 0, skippedReason: "too-short" };
      }
      const items = await extractMemoriesWithLlm(this.cfg, transcript, this.logger);
      const result = await this.storeExtractedItems(items, {
        sessionId: state.id,
        cwd: state.cwd,
        source: "auto-extract",
      });
      this.logger?.info?.(
        `[dsh-local-vector-memory] session ${state.id}: extracted ${result.extracted}, added ${result.added}, skipped ${result.skipped}`,
      );
      return result;
    } catch (error) {
      this.logger?.warn?.(
        `[dsh-local-vector-memory] auto extract failed for session ${state.id}: ${String(error?.message || error)}`,
      );
      return { extracted: 0, added: 0, skipped: 0, skippedReason: String(error?.message || error).slice(0, 300) };
    }
  }

  async extractText(text, meta = {}) {
    const transcript = buildTranscript([{ role: "user", text }], this.cfg.extractionTranscriptChars);
    if (transcript.length < this.cfg.extractionMinChars) {
      throw new Error(`文本太短(至少 ${this.cfg.extractionMinChars} 字符),无法可靠提取记忆`);
    }
    const items = await extractMemoriesWithLlm(this.cfg, transcript, this.logger);
    return this.storeExtractedItems(items, {
      sessionId: meta.sessionId || null,
      cwd: meta.cwd || "",
      source: meta.source || "manual-extract",
    });
  }

  async storeExtractedItems(items, meta = {}) {
    let added = 0;
    let skipped = 0;
    const cleanItems = (items || [])
      .map((item) => ({
        text: clipText(String(item.text || "").trim(), this.cfg.extractionMaxMemoryChars),
        tags: item?.tags || [],
      }))
      .filter((item) => item.text.length >= 4);
    if (cleanItems.length === 0) return { extracted: (items || []).length, added, skipped };
    let vectors = [];
    try {
      vectors = await this.embeddings.embedMany(cleanItems.map((i) => i.text));
    } catch (error) {
      this.logger?.debug?.(`[dsh-local-vector-memory] batch embed failed, falling back to single: ${String(error?.message || error)}`);
    }
    for (let i = 0; i < cleanItems.length; i += 1) {
      const item = cleanItems[i];
      let embedding = vectors[i] || null;
      if (!embedding) {
        try {
          embedding = await this.embeddings.embedOne(item.text);
        } catch {
          embedding = null;
        }
      }
      const duplicate = await this.findSimilar(item.text, embedding, this.cfg.extractionDedupScore);
      if (duplicate) {
        skipped += 1;
        continue;
      }
      try {
        this.store.add({
          text: item.text,
          embedding,
          tags: item.tags,
          source: meta.source || "auto-extract",
          sessionId: meta.sessionId || null,
          cwd: meta.cwd || "",
          meta: { method: "llm-extract" },
        });
        added += 1;
      } catch (error) {
        this.logger?.warn?.(`[dsh-local-vector-memory] store add failed: ${String(error?.message || error)}`);
      }
    }
    return { extracted: cleanItems.length, added, skipped };
  }

  /** 精确匹配或语义相似(>= minScore)时返回 { score, memory },否则 null。 */
  async findSimilar(text, queryVector = null, minScore = 0.92) {
    if (!this.store.ok) return null;
    const normalized = String(text || "").replace(/\s+/g, "");
    if (normalized.length < 4) return null;
    const listed = this.store.list({ limit: 200 });
    const exact = listed.find((r) => r.text.replace(/\s+/g, "") === normalized);
    if (exact) return { score: 1, memory: exact };
    if (!queryVector) {
      try {
        queryVector = await this.embeddings.embedOne(text);
      } catch {
        return null;
      }
    }
    const result = this.store.search({
      query: text,
      limit: 1,
      minScore: 0,
      keywordFallback: false,
      queryVector,
    });
    const top = result.results?.[0];
    if (top && top.match === "vector" && top.score >= minScore) return { score: top.score, memory: top };
    return null;
  }

  async addMemory({ text, tags }) {
    if (!this.store.ok) throw new Error(this.store.error ? `记忆库不可用: ${this.store.error.message}` : "记忆库不可用");
    const cleanText = String(text || "").trim();
    if (!cleanText) throw new Error("记忆内容不能为空");
    let embedding = null;
    let embedError = "";
    try {
      embedding = await this.embeddings.embedOne(cleanText);
    } catch (error) {
      embedError = String(error?.message || error);
    }
    if (this.cfg.skipDuplicates !== false) {
      const similar = await this.findSimilar(cleanText, embedding, this.cfg.conflictScore ?? this.cfg.extractionDedupScore);
      if (similar) {
        if (similar.score >= this.cfg.extractionDedupScore) {
          return {
            id: similar.memory.id,
            vectorized: true,
            duplicate: true,
            warning: `已存在相同或高度相似的记忆,未重复写入。`,
          };
        }
        return {
          id: similar.memory.id,
          vectorized: true,
          conflict: true,
          warning: `疑似与已有记忆冲突或过时(相似度 ${similar.score.toFixed(3)}):"${clipText(similar.memory.text, 100)}"。若本条是对旧记忆的更新,请调用 memory_update 更新旧记忆(id: ${similar.memory.id}),而不是新增一条互相矛盾的记忆。`,
        };
      }
    }
    const record = this.store.add({
      text: cleanText,
      embedding,
      tags,
      source: "manual",
      meta: { method: "manual" },
    });
    if (!record.hasVector && embedError) {
      return {
        id: record.id,
        vectorized: false,
        warning: `已保存但未向量化(embedding 服务不可用: ${embedError});之后可调用 memory_reindex 补向量。`,
      };
    }
    return { id: record.id, vectorized: record.hasVector, warning: "" };
  }

  async updateMemory({ id, text, tags }) {
    if (!this.store.ok) throw new Error(this.store.error ? `记忆库不可用: ${this.store.error.message}` : "记忆库不可用");
    const existing = this.store.get(String(id || "").trim());
    if (!existing) throw new Error(`未找到记忆 ${id}`);
    const cleanText = text !== undefined && text !== null ? String(text).trim() : existing.text;
    if (!cleanText) throw new Error("记忆内容不能为空");
    let embedding;
    let embedError = "";
    if (cleanText !== existing.text) {
      try {
        embedding = await this.embeddings.embedOne(cleanText);
      } catch (error) {
        embedError = String(error?.message || error);
        embedding = null;
      }
    }
    const record = this.store.update(existing.id, {
      text: cleanText,
      tags: tags !== undefined && tags !== null ? tags : existing.tags,
      ...(embedding !== undefined ? { embedding } : {}),
    });
    if (!record) throw new Error(`更新失败:记忆 ${id} 可能已被删除`);
    return {
      id: record.id,
      vectorized: record.hasVector,
      warning: record.hasVector ? "" : `向量化失败(${embedError}),请稍后调用 memory_reindex 补向量。`,
    };
  }

  /** SQLite 在线备份到 cfg.backupDir,自动清理保留最近 backupKeep 份。 */
  async backupMemory() {
    if (!this.store.ok) throw new Error("记忆库不可用");
    const dir = this.cfg.backupDir;
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").replace(/\..*$/, "");
    const dest = join(dir, `memory-${stamp}.sqlite`);
    this.store.backup(dest);
    let kept = 1;
    try {
      const files = readdirSync(dir)
        .filter((f) => /^memory-\d{8}-\d{6}\.sqlite$/.test(f))
        .sort();
      while (files.length > this.cfg.backupKeep) {
        unlinkSync(join(dir, files.shift()));
      }
      kept = files.length;
    } catch (error) {
      this.logger?.warn?.(`[dsh-local-vector-memory] backup prune failed: ${String(error?.message || error)}`);
    }
    return { dest, kept };
  }

  async searchMemories(query, limit = 5, signal, tag = "") {
    if (!this.store.ok) return { vectorized: false, queryVector: null, results: [] };
    let queryVector = null;
    let embedError = "";
    try {
      const timeoutSignal = signal ?? AbortSignal.timeout(this.cfg.embeddingTimeoutMs);
      queryVector = await this.embeddings.embedOne(query, timeoutSignal);
    } catch (error) {
      embedError = String(error?.message || error);
    }
    const result = this.store.search({
      query,
      limit,
      minScore: 0,
      keywordFallback: this.cfg.keywordFallback,
      queryVector,
      tag,
    });
    result.embedError = embedError;
    return result;
  }

  async reindex(limit = 100) {
    if (!this.store.ok) throw new Error("记忆库不可用");
    const candidates = this.store.missingVectorCandidates(limit);
    if (candidates.length === 0) return { indexed: 0, failed: 0, message: "没有待向量化的记忆。" };
    let vectors = [];
    try {
      vectors = await this.embeddings.embedMany(candidates.map((m) => m.text));
    } catch (error) {
      this.logger?.debug?.(`[dsh-local-vector-memory] reindex batch embed failed: ${String(error?.message || error)}`);
    }
    let indexed = 0;
    let failed = 0;
    for (let i = 0; i < candidates.length; i += 1) {
      try {
        const vector = vectors[i];
        if (!vector) {
          failed += 1;
          continue;
        }
        if (this.store.updateEmbedding(candidates[i].id, vector)) indexed += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
    }
    return { indexed, failed, message: `完成:成功补向量 ${indexed} 条,失败 ${failed} 条。` };
  }

  stats() {
    if (!this.store.ok) return { ok: false, error: String(this.store.error?.message || this.store.error || "store unavailable") };
    const stats = this.store.stats();
    return { ok: true, ...stats, embeddingBaseUrl: this.cfg.embeddingBaseUrl, extractionBaseUrl: this.cfg.extractionBaseUrl };
  }
}

export function extractEventText(event) {
  if (!event || typeof event !== "object") return "";
  let message = null;
  if (event.type === "user/message") message = event.data;
  else if (event.type === "assistant/message") message = event.data?.message;
  if (!message || typeof message !== "object") return "";
  if (message.source?.kind === "plugin") return "";
  if (message.role === "tool" || message.source?.kind === "tool") return "";
  return messageText(message);
}

export function eventRole(event) {
  if (event?.type === "assistant/message") return "assistant";
  return "user";
}

export function messageText(message) {
  if (!message || typeof message !== "object") return "";
  if (message.source?.kind === "plugin") return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  const parts = [];
  for (const block of message.content) {
    if (!block || typeof block !== "object") continue;
    const type = String(block.type || block.kind || "").toLowerCase();
    if (type === "text" || type === "input_text" || type === "output_text") {
      if (typeof block.text === "string") parts.push(block.text);
      else if (typeof block.content === "string") parts.push(block.content);
    } else if (type === "content" && Array.isArray(block.content)) {
      for (const inner of block.content) {
        if (typeof inner?.text === "string") parts.push(inner.text);
      }
    }
  }
  return parts.filter(Boolean).join("\n").trim();
}

export function userQuery(messages, maxChars = 2000) {
  const parts = [];
  for (const message of messages || []) {
    if (!message || typeof message !== "object") continue;
    const role = message.role || message.type;
    if (role !== "user") continue;
    if (message.source?.kind === "tool" || message.source?.kind === "plugin") continue;
    const text = messageText(message);
    if (text) parts.push(text);
  }
  return clipText(parts.slice(-2).join("\n").trim(), maxChars);
}

export function cleanAutoCaptureText(text, maxChars) {
  return clipText(
    String(text || "")
      .trim()
      .replace(/^(?:请[你您]?)?(?:记住|记下|记着)[::,，。]?\s*/i, "")
      .trim(),
    maxChars,
  );
}

export function clipText(text, maxChars) {
  const value = String(text || "");
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function quickHash(text) {
  return createHash("sha1").update(String(text)).digest("hex");
}
