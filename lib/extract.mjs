const EXTRACT_SYSTEM_PROMPT = [
  "你是长期记忆提取器。从对话中只提取跨会话仍有价值的事实、用户偏好、约定、决定、环境约束。",
  "不要提取寒暄、过程细节、工具输出、临时文件路径。每条记忆必须是独立完整的中文陈述,包含必要上下文。",
  '只输出一个 JSON 对象,格式:{"memories":[{"text":"...","tags":["..."]}]},不要 Markdown、不要解释。',
  "没有值得记的内容就输出 {\"memories\":[]}。最多提取 8 条。",
].join(" ");

export async function extractMemoriesWithLlm(cfg, transcript, logger = console) {
  const chunks = splitTranscript(transcript, cfg.extractionChunkChars, cfg.extractionMaxChunks);
  if (chunks.length === 0) return [];
  const merged = [];
  const seen = new Set();
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const items = await extractSingleChunk(cfg, chunk, index + 1, chunks.length, logger);
    for (const item of items) {
      const key = String(item.text || "").replace(/\s+/g, "");
      if (key.length < 4 || seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
      if (merged.length >= cfg.extractionMaxItems) return merged;
    }
  }
  if (merged.length === 0) {
    logger?.debug?.("[dsh-local-vector-memory] extraction returned no memories");
  }
  return merged;
}

async function extractSingleChunk(cfg, chunk, chunkIndex, chunkCount, logger) {
  const body = {
    model: cfg.extractionModel,
    messages: [
      { role: "system", content: EXTRACT_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          `以下是本次会话的第 ${chunkIndex}/${chunkCount} 段记录(只提取长期记忆):`,
          "",
          chunk,
          "",
          "提取记忆:",
        ].join("\n"),
      },
    ],
    max_tokens: cfg.extractionMaxTokens,
    temperature: 0.2,
    reasoning_effort: cfg.extractionReasoningEffort,
  };
  const response = await fetch(`${cfg.extractionBaseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cfg.extractionApiKey ? { authorization: `Bearer ${cfg.extractionApiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(cfg.extractionTimeoutMs),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `extraction endpoint ${cfg.extractionBaseUrl} returned ${response.status}: ${
        payload?.error?.message || payload?.message || "unknown error"
      }`,
    );
  }
  const content = payload?.choices?.[0]?.message?.content;
  const items = parseMemoryItems(content);
  logger?.debug?.(
    `[dsh-local-vector-memory] extraction chunk ${chunkIndex}/${chunkCount}: ${items.length} item(s)`,
  );
  return items;
}

export function splitTranscript(transcript, maxChars, maxChunks) {
  const text = String(transcript || "");
  const limit = Math.max(200, Number(maxChars) || 1000);
  const chunks = [];
  const paragraphs = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  let current = "";
  for (const paragraph of paragraphs) {
    if (paragraph.length > limit) {
      if (current) {
        chunks.push(current.trim());
        current = "";
      }
      for (let i = 0; i < paragraph.length; i += limit) {
        chunks.push(paragraph.slice(i, i + limit).trim());
      }
      continue;
    }
    if (current && current.length + paragraph.length + 1 > limit) {
      chunks.push(current.trim());
      current = paragraph;
    } else {
      current = current ? `${current}\n${paragraph}` : paragraph;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.slice(0, Math.max(1, Number(maxChunks) || chunks.length));
}

export function parseMemoryItems(content) {
  const text = String(content || "");
  if (!text.trim()) return [];
  let json = null;
  // 1) 整段 JSON
  try {
    json = JSON.parse(text.trim());
  } catch {
    // continue
  }
  // 2) 去掉代码块后再试
  if (!json) {
    const unboxed = text.replace(/```(?:json)?\s*([\s\S]*?)```/gi, "$1").trim();
    try {
      json = JSON.parse(unboxed);
    } catch {
      // continue
    }
  }
  // 3) 提取第一个平衡的大括号对象
  if (!json) {
    json = extractBalancedObject(text);
  }
  const raw = Array.isArray(json?.memories) ? json.memories : Array.isArray(json) ? json : [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const memoryText = String(item.text ?? item.content ?? item.memory ?? "").trim();
    if (memoryText.length < 4) continue;
    const tags = Array.isArray(item.tags)
      ? item.tags.map((t) => String(t ?? "").trim()).filter(Boolean)
      : [];
    out.push({ text: memoryText.slice(0, 2000), tags: tags.slice(0, 10) });
  }
  return out;
}

export function buildTranscript(entries, maxChars = 12000) {
  const lines = [];
  let total = 0;
  for (const entry of entries || []) {
    const role = entry.role === "assistant" ? "助手" : "用户";
    const text = String(entry.text || "").trim();
    if (!text) continue;
    const remaining = maxChars - total;
    if (remaining <= 0) break;
    const clipped = text.length > remaining ? `${text.slice(0, remaining)}…` : text;
    lines.push(`${role}: ${clipped}`);
    total += clipped.length + 4;
    if (total >= maxChars) break;
  }
  return lines.join("\n");
}

export function formatExtractResults(items, added, skipped) {
  const lines = items.map((item) => `- ${item.text}${item.tags.length > 0 ? ` [${item.tags.join(", ")}]` : ""}`);
  return `提取 ${items.length} 条记忆:新增 ${added} 条,重复跳过 ${skipped} 条。\n${lines.join("\n")}`;
}

function extractBalancedObject(text) {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
