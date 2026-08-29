import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const PLUGIN_ID = "local-vector-memory";
export const PLUGIN_SOURCE = "local-vector-memory";

const USER_HOME = process.env.HOME ?? homedir();
export const DSH_HOME = process.env.DSH_HOME ?? join(USER_HOME, ".dsh");

export const DEFAULT_CONFIG = Object.freeze({
  /** 向量数据库路径,支持 ~ 展开 */
  dbPath: join(DSH_HOME, "storages", "local-vector-memory", "memory.sqlite"),

  /** embedding 服务(OpenAI 兼容)。"auto" = 自动探测 WSL 默认网关 + embeddingPort */
  embeddingEndpoint: "auto",
  embeddingPort: 8081,
  embeddingApiKey: "local-no-auth",
  embeddingModel: "local-embedding",
  embeddingTimeoutMs: 8000,
  embeddingBatchSize: 16,

  /** 每个 agent/pre-step 自动召回 */
  autoRecall: true,
  recallTopK: 5,
  recallMinScore: 0.55,
  recallMinQueryLength: 4,
  recallMaxQueryChars: 2000,
  /** 同一个 query 在一个 session 内只召回一次(防止同一轮工具调用反复注入) */
  recallDedupePerSession: true,

  /** 会话 flush 时用本地 9B 自动提取记忆 */
  autoExtract: false,
  extractionEndpoint: "auto",
  extractionPort: 8080,
  extractionApiKey: "local-no-auth",
  extractionModel: "qwythos-9b",
  extractionTimeoutMs: 180000,
  extractionMaxTokens: 1600,
  extractionReasoningEffort: "minimal",
  extractionChunkChars: 1000,
  extractionMaxChunks: 6,
  extractionMinChars: 80,
  extractionMaxItems: 8,
  extractionMaxMemoryChars: 500,
  extractionTranscriptChars: 12000,

  /** 用户消息包含记忆线索时自动向量化保存(不需要 9B,毫秒级完成) */
  autoCapture: true,
  autoCaptureMinChars: 8,
  autoCaptureMaxChars: 600,
  autoCaptureCues: "记住|记下|以后|从此|总是|不要|别再|必须|偏好|喜欢|习惯|约定|规定|配置|环境|决定|要求|下次|每次|始终|千万|保持",
  extractionDedupScore: 0.92,

  /** 捕获用户/助手文本的会话转录上限 */
  captureMaxChars: 40000,

  /** 无向量结果或 embedding 服务不可用时的关键词兜底 */
  keywordFallback: true,

  /** memory_add 遇到相同/高度相似记忆时跳过,避免重复 */
  skipDuplicates: true,

  /** memory_search 返回的每条记忆最多展示字符数 */
  displayMaxChars: 600,

  /** 软删除:memory_forget 默认只标记删除,memory_restore 可恢复;purge=true 才硬删 */
  softDelete: true,

  /** 在线备份目录与保留份数(memory_backup 工具使用) */
  backupDir: join(DSH_HOME, "backups", "memory"),
  backupKeep: 5,

  /** 新记忆与现有记忆的冲突提示阈值:相似度 >= 此值但未达完全重复时,提示用 memory_update 更新旧记忆 */
  conflictScore: 0.86,

  /** 会话内召回去重 LRU 上限(同一查询哈希在最近 N 次召回内不再注入) */
  recallDedupeLru: 16,

  /** 置顶核心记忆(pinned)在会话首次召回时整体注入一次 */
  recallPinned: true,

  /** 内置定时备份间隔(小时),0 = 关闭;备份走 VACUUM INTO,自动保留 backupKeep 份 */
  backupIntervalHours: 24,
});

export function resolveConfig(input = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(input && typeof input === "object" ? input : {}) };
  cfg.dbPath = expandHome(String(cfg.dbPath || DEFAULT_CONFIG.dbPath));
  cfg.embeddingEndpoint = String(cfg.embeddingEndpoint || "auto");
  cfg.embeddingPort = clampInt(cfg.embeddingPort, 1, 65535, DEFAULT_CONFIG.embeddingPort);
  cfg.embeddingModel = String(cfg.embeddingModel || "local-embedding");
  cfg.embeddingApiKey = String(cfg.embeddingApiKey ?? "");
  cfg.embeddingTimeoutMs = clampInt(cfg.embeddingTimeoutMs, 500, 60000, DEFAULT_CONFIG.embeddingTimeoutMs);
  cfg.embeddingBatchSize = clampInt(cfg.embeddingBatchSize, 1, 64, DEFAULT_CONFIG.embeddingBatchSize);

  cfg.autoRecall = cfg.autoRecall !== false;
  cfg.recallTopK = clampInt(cfg.recallTopK, 1, 20, DEFAULT_CONFIG.recallTopK);
  cfg.recallMinScore = clampNumber(cfg.recallMinScore, 0, 1, DEFAULT_CONFIG.recallMinScore);
  cfg.recallMinQueryLength = clampInt(cfg.recallMinQueryLength, 1, 64, DEFAULT_CONFIG.recallMinQueryLength);
  cfg.recallMaxQueryChars = clampInt(cfg.recallMaxQueryChars, 100, 20000, DEFAULT_CONFIG.recallMaxQueryChars);
  cfg.recallDedupePerSession = cfg.recallDedupePerSession !== false;

  cfg.autoExtract = cfg.autoExtract === true;
  cfg.extractionEndpoint = String(cfg.extractionEndpoint || "auto");
  cfg.extractionPort = clampInt(cfg.extractionPort, 1, 65535, DEFAULT_CONFIG.extractionPort);
  cfg.extractionModel = String(cfg.extractionModel || "qwythos-9b");
  cfg.extractionApiKey = String(cfg.extractionApiKey ?? "");
  cfg.extractionTimeoutMs = clampInt(cfg.extractionTimeoutMs, 5000, 600000, DEFAULT_CONFIG.extractionTimeoutMs);
  cfg.extractionMaxTokens = clampInt(cfg.extractionMaxTokens, 100, 8000, DEFAULT_CONFIG.extractionMaxTokens);
  cfg.extractionReasoningEffort = String(cfg.extractionReasoningEffort || "minimal");
  cfg.extractionChunkChars = clampInt(cfg.extractionChunkChars, 200, 12000, DEFAULT_CONFIG.extractionChunkChars);
  cfg.extractionMaxChunks = clampInt(cfg.extractionMaxChunks, 1, 20, DEFAULT_CONFIG.extractionMaxChunks);
  cfg.extractionMinChars = clampInt(cfg.extractionMinChars, 20, 100000, DEFAULT_CONFIG.extractionMinChars);
  cfg.extractionMaxItems = clampInt(cfg.extractionMaxItems, 1, 20, DEFAULT_CONFIG.extractionMaxItems);
  cfg.extractionMaxMemoryChars = clampInt(cfg.extractionMaxMemoryChars, 50, 5000, DEFAULT_CONFIG.extractionMaxMemoryChars);
  cfg.extractionTranscriptChars = clampInt(cfg.extractionTranscriptChars, 500, 100000, DEFAULT_CONFIG.extractionTranscriptChars);
  cfg.extractionDedupScore = clampNumber(cfg.extractionDedupScore, 0, 1, DEFAULT_CONFIG.extractionDedupScore);

  cfg.captureMaxChars = clampInt(cfg.captureMaxChars, 1000, 500000, DEFAULT_CONFIG.captureMaxChars);
  cfg.autoCapture = cfg.autoCapture !== false;
  cfg.autoCaptureMinChars = clampInt(cfg.autoCaptureMinChars, 4, 1000, DEFAULT_CONFIG.autoCaptureMinChars);
  cfg.autoCaptureMaxChars = clampInt(cfg.autoCaptureMaxChars, 20, 5000, DEFAULT_CONFIG.autoCaptureMaxChars);
  cfg.autoCaptureCues = String(cfg.autoCaptureCues || DEFAULT_CONFIG.autoCaptureCues);
  cfg.keywordFallback = cfg.keywordFallback !== false;
  cfg.displayMaxChars = clampInt(cfg.displayMaxChars, 100, 10000, DEFAULT_CONFIG.displayMaxChars);
  cfg.skipDuplicates = cfg.skipDuplicates !== false;

  cfg.softDelete = cfg.softDelete !== false;
  cfg.backupDir = expandHome(String(cfg.backupDir || DEFAULT_CONFIG.backupDir));
  cfg.backupKeep = clampInt(cfg.backupKeep, 1, 100, DEFAULT_CONFIG.backupKeep);
  cfg.conflictScore = clampNumber(cfg.conflictScore, 0, 1, DEFAULT_CONFIG.conflictScore);
  cfg.recallDedupeLru = clampInt(cfg.recallDedupeLru, 1, 128, DEFAULT_CONFIG.recallDedupeLru);
  cfg.recallPinned = cfg.recallPinned !== false;
  cfg.backupIntervalHours = clampInt(cfg.backupIntervalHours, 0, 720, DEFAULT_CONFIG.backupIntervalHours);

  const gateway = wslGateway();
  cfg.embeddingBaseUrl = normalizeBaseUrl(cfg.embeddingEndpoint, cfg.embeddingPort, gateway);
  cfg.extractionBaseUrl = normalizeBaseUrl(cfg.extractionEndpoint, cfg.extractionPort, gateway);
  cfg.gateway = gateway;
  return cfg;
}

export function normalizeBaseUrl(spec, defaultPort, gateway) {
  const value = String(spec || "auto").trim();
  if (value === "auto" || value === "gateway" || value === "wsl-gateway") {
    return `http://${gateway}:${defaultPort}/v1`;
  }
  if (value === "localhost" || value === "127.0.0.1") {
    return `http://127.0.0.1:${defaultPort}/v1`;
  }
  if (/^https?:\/\//i.test(value)) {
    return value.replace(/\/+$/, "");
  }
  if (/^[\w.-]+:\d+$/.test(value)) {
    return `http://${value}/v1`;
  }
  return `http://${value}:${defaultPort}/v1`;
}

export function wslGateway() {
  if (process.env.WSL_GATEWAY) return process.env.WSL_GATEWAY;
  try {
    const text = readFileSync("/proc/net/route", "utf8");
    for (const line of text.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 11) continue;
      // Iface Destination Gateway Flags ...
      if (cols[1] !== "00000000") continue;
      const hex = cols[2];
      if (!/^[0-9a-fA-F]{8}$/.test(hex)) continue;
      const octets = [
        parseInt(hex.slice(6, 8), 16),
        parseInt(hex.slice(4, 6), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(0, 2), 16),
      ];
      return octets.join(".");
    }
  } catch {
    // fall through
  }
  return "127.0.0.1";
}

export function expandHome(path) {
  const value = String(path || "");
  if (value === "~") return USER_HOME;
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(USER_HOME, value.slice(2));
  return value;
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
