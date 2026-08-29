import { MemoryStore } from "./lib/store.mjs";
import { EmbeddingClient } from "./lib/embedding.mjs";
import { LocalMemoryRuntime } from "./lib/runtime.mjs";
import { resolveConfig, PLUGIN_ID } from "./lib/config.mjs";
import { registerMemoryTools } from "./lib/tools.mjs";
import { PROMPT_TEXT } from "./lib/prompt.mjs";

export const name = PLUGIN_ID;
export const inject = ["tools", "systemPrompt", "agents", "sessions"];

export function apply(ctx, input = {}) {
  const logger = ctx.logger ?? console;
  const cfg = resolveConfig(input);
  const store = new MemoryStore(cfg.dbPath, logger);
  const embeddings = new EmbeddingClient(cfg, logger);
  const runtime = new LocalMemoryRuntime(cfg, store, embeddings, logger);

  ctx.provide("localVectorMemory", {
    config: cfg,
    runtime,
    store,
    embeddings,
  });

  const backupTimer = cfg.backupIntervalHours > 0
    ? setInterval(() => {
        runtime.backupMemory().catch((error) => {
          logger?.debug?.(
            `[dsh-local-vector-memory] scheduled backup failed: ${String(error?.message || error)}`,
          );
        });
      }, cfg.backupIntervalHours * 3600 * 1000)
    : null;
  if (backupTimer && typeof backupTimer.unref === "function") backupTimer.unref();

  ctx.effect(
    () => () => {
      if (backupTimer) clearInterval(backupTimer);
      try {
        store.close();
      } catch {
        // ignore
      }
    },
    "dsh-local-vector-memory.dispose",
  );

  ctx.effect(
    () =>
      ctx.systemPrompt.section({
        name: "tool:dsh-local-vector-memory",
        order: 116,
        text: PROMPT_TEXT,
      }),
    "dsh-local-vector-memory.prompt",
  );

  // prepend: 等其它 waterfall 插件先贡献完,再把召回记忆追加到最终消息列表末尾。
  ctx.on(
    "agent/pre-step",
    async ({ agent, messages, signal }, next) => {
      const decision = await next();
      if (decision.kind !== "enter" || signal?.aborted) return decision;
      const recall = await runtime.recallMessage(agent, decision.messages, signal);
      if (!recall) return decision;
      return { kind: "enter", messages: [...decision.messages, recall] };
    },
    { prepend: true },
  );

  ctx.on("session/event", (session, event) => {
    try {
      runtime.capture(session, event);
    } catch (error) {
      logger?.debug?.(`[dsh-local-vector-memory] capture failed: ${String(error?.message || error)}`);
    }
  });

  ctx.on("session/flush", async (session) => {
    try {
      await runtime.flush(session);
    } catch (error) {
      logger?.warn?.(`[dsh-local-vector-memory] flush failed: ${String(error?.message || error)}`);
    }
  });

  registerMemoryTools(ctx, runtime).catch((error) => {
    logger?.warn?.(
      `[dsh-local-vector-memory] tools not registered: ${String(error?.message || error)}`,
    );
  });
}
