import { resolveConfig } from "../lib/config.mjs";
import { MemoryStore } from "../lib/store.mjs";
import { EmbeddingClient } from "../lib/embedding.mjs";
import { LocalMemoryRuntime } from "../lib/runtime.mjs";

const cfg = resolveConfig({ dbPath: "/tmp/memtest/integ.sqlite" });
cfg.backupDir = "/tmp/memtest/backups";
cfg.backupKeep = 3;
const store = new MemoryStore(cfg.dbPath, console);
const embeddings = new EmbeddingClient(cfg, console);
const runtime = new LocalMemoryRuntime(cfg, store, embeddings, console);

const r1 = await runtime.addMemory({ text: "用户偏好:DSH 默认模型是云端 deepseek-v4-pro。", tags: "偏好,DSH" });
console.log("add1:", JSON.stringify(r1));
const r2 = await runtime.addMemory({ text: "用户偏好:DSH 默认模型是云端 deepseek-v4-pro。", tags: "偏好" });
console.log("add2(应重复):", JSON.stringify(r2));
const r3 = await runtime.addMemory({ text: "用户偏好:DSH 默认模型已改为本地 qwythos-9b。", tags: "偏好,DSH" });
console.log("add3(应冲突):", JSON.stringify(r3));
if (r3.conflict) {
  const up = await runtime.updateMemory({ id: r3.id, text: "用户偏好:DSH 默认模型已改为本地 qwythos-9b。" });
  console.log("冲突条目转正(update):", JSON.stringify(up));
}
const upd = await runtime.updateMemory({ id: r1.id, text: "用户偏好:DSH 默认模型是云端 deepseek-v4-pro,reasoningEffort=max。", tags: "偏好,DSH,模型" });
console.log("update r1:", JSON.stringify(upd));
const bk = await runtime.backupMemory();
console.log("backup:", JSON.stringify(bk));
const s2 = await runtime.searchMemories("DSH 默认模型是什么", 5);
console.log("search hits:", s2.results.map(r => r.text.slice(0, 50) + " @" + r.score.toFixed(3)).join(" | "));
const del = store.forget(r2.duplicate ? r2.id : r1.id);
console.log("soft forget:", del);
const restore = store.restore(r2.duplicate ? r2.id : r1.id);
console.log("restore:", restore);
store.close();
console.log("INTEGRATION OK");
