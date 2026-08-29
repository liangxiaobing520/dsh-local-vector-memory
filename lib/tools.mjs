import { loadDefineTool } from "./peers.mjs";

const TEXT_OUTPUT = {
  schema: { type: "string" },
  render: (_args, value) => [{ type: "text", text: String(value) }],
};

export async function registerMemoryTools(ctx, runtime) {
  const defineTool = await loadDefineTool();

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: "memory_add",
          description:
            "把一条值得长期记住的信息写入本地向量记忆库(用户偏好、约定、决定、环境事实等)。用户说\"记住...\"时主动调用。文本会先本地 embedding 成向量,再存入 SQLite;embedding 服务不可用时仍会保存,之后可 memory_reindex 补向量。",
          parameters: {
            text: { type: "string", required: true, description: "完整、独立、带必要上下文的中文记忆陈述。" },
            tags: { type: "string", description: "可选标签,逗号分隔,如 \"偏好,环境\"。" },
          },
          output: TEXT_OUTPUT,
          isConcurrencySafe: () => true,
          execute: async (args) => {
            const result = await runtime.addMemory({ text: args?.text, tags: args?.tags });
            if (result.duplicate) return `未重复写入:${result.warning}`;
            if (result.warning) return `已写入记忆 ${result.id}。\n⚠️ ${result.warning}`;
            return `已写入记忆 ${result.id}(已向量化)。`;
          },
        }),
      ),
    "dsh-local-vector-memory.tool.add",
  );

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: "memory_search",
          description:
            "用向量相似度检索本地长期记忆。在回答\"我之前说过什么/有什么偏好/上次怎么定的\"之前先调用。embedding 服务不可用时会退化为关键词匹配。",
          parameters: {
            query: { type: "string", required: true, description: "检索问题或相关描述,尽量具体。" },
            limit: { type: "number", description: "最多返回条数,默认 5,最大 20。" },
            tag: { type: "string", description: "可选,只检索含该标签的记忆,如 偏好 或 踩坑。" },
          },
          output: TEXT_OUTPUT,
          isConcurrencySafe: () => true,
          execute: async (args, exec) => {
            const query = String(args?.query ?? "").trim();
            if (!query) return "memory_search: query 不能为空。";
            const limit = clampInt(args?.limit, 1, 20, 5);
            const result = await runtime.searchMemories(query, limit, exec?.signal, String(args?.tag ?? ""));
            const hits = result.results || [];
            if (hits.length === 0) {
              const hint = result.embedError
                ? `embedding 服务不可用:${result.embedError}`
                : "没有找到相关记忆。";
              return `本地向量记忆检索:0 条。${hint}`;
            }
            const vectorHits = hits.filter((r) => r.match === "vector").length;
            const lines = hits.map((r, i) => {
              const time = String(r.createdAt || "").replace("T", " ").slice(0, 19);
              const tags = r.tags?.length > 0 ? ` [${r.tags.join(", ")}]` : "";
              return `${i + 1}. [${r.score.toFixed(3)}|${r.match}] ${r.text}${tags} (${r.id}, ${time})`;
            });
            const note = result.embedError ? `\n(embedding 服务不可用,以上为关键词兜底:${result.embedError})` : "";
            return `本地向量记忆检索:${hits.length} 条(向量 ${vectorHits} / 关键词 ${hits.length - vectorHits})\n${lines.join("\n")}${note}`;
          },
        }),
      ),
    "dsh-local-vector-memory.tool.search",
  );

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: "memory_list",
          description: "列出本地记忆库中的最近记忆(可按标签过滤),用于浏览/确认已有内容。",
          parameters: {
            limit: { type: "number", description: "最多返回条数,默认 20,最大 200。" },
            tag: { type: "string", description: "可选标签过滤,只返回含该标签的记忆。" },
            source: { type: "string", description: "可选来源过滤:manual / auto-extract / manual-extract。" },
            includeDeleted: { type: "boolean", description: "默认 false;true 时列出软删除的记忆(回收站)。" },
          },
          output: TEXT_OUTPUT,
          isConcurrencySafe: () => true,
          execute: async (args) => {
            if (!runtime.store.ok) return `记忆库不可用:${String(runtime.store.error?.message || runtime.store.error)}`;
            const rows = runtime.store.list({
              limit: clampInt(args?.limit, 1, 200, 20),
              tag: String(args?.tag ?? ""),
              source: String(args?.source ?? ""),
              includeDeleted: args?.includeDeleted === true,
            });
            if (rows.length === 0) return "本地记忆库为空。";
            const lines = rows.map((r, i) => {
              const time = String(r.createdAt || "").replace("T", " ").slice(0, 19);
              const tags = r.tags?.length > 0 ? ` [${r.tags.join(", ")}]` : "";
              const vec = r.hasVector ? "vec" : "text-only";
              const del = r.deletedAt ? " [已删除]" : "";
              return `${i + 1}. ${r.id} ${time} [${r.source}/${vec}]${tags}${del}\n   ${clipText(r.text, 300)}`;
            });
            return `本地记忆(${rows.length} 条,新→旧):\n${lines.join("\n")}`;
          },
        }),
      ),
    "dsh-local-vector-memory.tool.list",
  );

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: "memory_forget",
          description: "按 id 删除一条本地记忆。默认软删除(可被 memory_restore 恢复);purge=true 时永久删除。只在用户明确要求删除时使用;id 从 memory_list / memory_search 获取。",
          parameters: {
            id: { type: "string", required: true, description: "记忆 id。" },
            purge: { type: "boolean", description: "默认 false(软删除,可恢复);true 时永久删除。" },
          },
          output: TEXT_OUTPUT,
          isConcurrencySafe: () => true,
          execute: async (args) => {
            if (!runtime.store.ok) return `记忆库不可用:${String(runtime.store.error?.message || runtime.store.error)}`;
            const id = String(args?.id ?? "").trim();
            if (!id) return "memory_forget: id 不能为空。";
            const deleted = runtime.store.forget(id, { soft: !args?.purge });
            if (!deleted) return `未找到记忆 ${id}(或已删除)。`;
            return args?.purge
              ? `已永久删除记忆 ${id}。`
              : `已删除记忆 ${id}(软删除,可调用 memory_restore 恢复)。`;
          },
        }),
      ),
    "dsh-local-vector-memory.tool.forget",
  );

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: "memory_restore",
          description: "恢复被软删除的记忆(回收站)。id 从 memory_list(includeDeleted=true)或删除时的提示获取。",
          parameters: {
            id: { type: "string", required: true, description: "被软删除的记忆 id。" },
          },
          output: TEXT_OUTPUT,
          isConcurrencySafe: () => true,
          execute: async (args) => {
            if (!runtime.store.ok) return `记忆库不可用:${String(runtime.store.error?.message || runtime.store.error)}`;
            const id = String(args?.id ?? "").trim();
            if (!id) return "memory_restore: id 不能为空。";
            const restored = runtime.store.restore(id);
            return restored ? `已恢复记忆 ${id}。` : `未找到已删除的记忆 ${id}。`;
          },
        }),
      ),
    "dsh-local-vector-memory.tool.restore",
  );

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: "memory_update",
          description: "按 id 更新一条已有记忆的文本/标签(文本变化时自动重新向量化)。用于纠正过时或冲突的记忆,而不是新增重复条目。id 从 memory_list / memory_search 获取。",
          parameters: {
            id: { type: "string", required: true, description: "要更新的记忆 id。" },
            text: { type: "string", description: "新的完整记忆文本(可选;不传则保留原文本)。" },
            tags: { type: "string", description: "新标签,逗号分隔(可选;不传则保留原标签)。" },
          },
          output: TEXT_OUTPUT,
          isConcurrencySafe: () => true,
          execute: async (args) => {
            const id = String(args?.id ?? "").trim();
            if (!id) return "memory_update: id 不能为空。";
            try {
              const result = await runtime.updateMemory({ id, text: args?.text, tags: args?.tags });
              if (result.warning) return `已更新记忆 ${result.id}。\n⚠️ ${result.warning}`;
              return `已更新记忆 ${result.id}(已重新向量化)。`;
            } catch (error) {
              return `memory_update 失败:${String(error?.message || error)}`;
            }
          },
        }),
      ),
    "dsh-local-vector-memory.tool.update",
  );

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: "memory_backup",
          description: "用 SQLite 在线备份(VACUUM INTO)把记忆库复制到备份目录(默认 ~/.dsh/backups/memory),自动保留最近 5 份。建议在大量增删改后调用。",
          parameters: {},
          output: TEXT_OUTPUT,
          isConcurrencySafe: () => true,
          execute: async () => {
            try {
              const result = await runtime.backupMemory();
              return `已备份记忆库到 ${result.dest}(当前保留 ${result.kept} 份)。`;
            } catch (error) {
              return `备份失败:${String(error?.message || error)}`;
            }
          },
        }),
      ),
    "dsh-local-vector-memory.tool.backup",
  );

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: "memory_stats",
          description: "查看本地向量记忆库状态:总条数、已向量化数量、来源分布、embedding 服务地址等。",
          parameters: {},
          output: TEXT_OUTPUT,
          isConcurrencySafe: () => true,
          execute: async () => {
            const stats = runtime.stats();
            if (!stats.ok) return `记忆库不可用:${stats.error}`;
            const sources = stats.sources.length > 0
              ? stats.sources.map((s) => `${s.source}:${s.count}`).join(", ")
              : "无";
            return [
              `本地向量记忆库:${stats.dbPath}`,
              `总数 ${stats.total} | 已向量化 ${stats.vectorized} | 未向量化 ${stats.missingVectors} | 软删除 ${stats.deleted}`,
              `向量维度:${stats.dimensions.length > 0 ? stats.dimensions.join(", ") : "无"}`,
              `来源分布:${sources}`,
              `embedding 服务:${stats.embeddingBaseUrl}`,
              `提取服务:${stats.extractionBaseUrl}`,
            ].join("\n");
          },
        }),
      ),
    "dsh-local-vector-memory.tool.stats",
  );

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: "memory_reindex",
          description: "为因 embedding 服务暂时不可用而保存的纯文本记忆补算向量。embedding 服务恢复后调用。",
          parameters: {
            limit: { type: "number", description: "最多处理条数,默认 100,最大 1000。" },
          },
          output: TEXT_OUTPUT,
          isConcurrencySafe: () => true,
          execute: async (args) => {
            const result = await runtime.reindex(clampInt(args?.limit, 1, 1000, 100));
            return `memory_reindex: ${result.message}`;
          },
        }),
      ),
    "dsh-local-vector-memory.tool.reindex",
  );

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: "memory_extract",
          description:
            "调用本地 9B 从一段文本/对话中提取长期记忆并写入记忆库。只适合较短的资料(建议不超过 2000 字;Qwythos 是长思考链模型,长文本会超时)。用户给一段资料说\"把这些记下来\"时使用;一句话直接 memory_add。",
          parameters: {
            text: { type: "string", required: true, description: "要提取记忆的文本或对话记录。" },
            source: { type: "string", description: "来源标记,默认 manual-extract。" },
          },
          output: TEXT_OUTPUT,
          isConcurrencySafe: () => true,
          timeoutMs: 300000,
          execute: async (args) => {
            const text = String(args?.text ?? "").trim();
            if (!text) return "memory_extract: text 不能为空。";
            const result = await runtime.extractText(text, { source: args?.source || "manual-extract" });
            if (result.extracted === 0) return "本地 9B 没有提取到值得长期保存的记忆。";
            return `提取 ${result.extracted} 条,新增 ${result.added} 条,重复跳过 ${result.skipped} 条。`;
          },
        }),
      ),
    "dsh-local-vector-memory.tool.extract",
  );
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function clipText(text, maxChars) {
  const value = String(text || "");
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}
