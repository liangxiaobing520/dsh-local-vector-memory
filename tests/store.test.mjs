import { DatabaseSync } from "node:sqlite";
import { MemoryStore } from "../lib/store.mjs";

// 旧库迁移测试:先建无 deleted_at 列的旧结构
const legacy = new DatabaseSync("/tmp/memtest/legacy.sqlite");
legacy.exec(`CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT NOT NULL, embedding BLOB, dim INTEGER, tags TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL DEFAULT 'manual', session_id TEXT, cwd TEXT, meta TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`);
legacy.close();
const s = new MemoryStore("/tmp/memtest/legacy.sqlite", console);
const cols = s.db.prepare("PRAGMA table_info(memories)").all().map(r => r.name);
console.log("迁移后含 deleted_at:", cols.includes("deleted_at"));

// 新功能测试
const a = s.add({ text: "测试记忆A", tags: ["t1"], source: "manual" });
const b = s.add({ text: "测试记忆B", tags: "t2,t3", source: "manual" });
console.log("add:", a.id.slice(0,8), b.id.slice(0,8));
console.log("list 2:", s.list({ limit: 10 }).map(r => r.text).join(" | "));
console.log("forget B(soft):", s.forget(b.id));
console.log("list 过滤已删:", s.list({ limit: 10 }).map(r => r.text).join(" | "));
console.log("includeDeleted:", s.list({ limit: 10, includeDeleted: true }).map(r => r.text + (r.deletedAt ? "(del)" : "")).join(" | "));
console.log("restore B:", s.restore(b.id));
console.log("list 恢复后:", s.list({ limit: 10 }).map(r => r.text).join(" | "));
const up = s.update(a.id, { text: "测试记忆A-改", tags: ["t1", "new"], embedding: new Float32Array(1024).fill(0.1) });
console.log("update A:", up.text, up.tags.join(","), "dim:", up.dim);
const upNull = s.update(a.id, { text: "测试记忆A-再改", embedding: null });
console.log("update 清向量:", upNull.text, "hasVector:", upNull.hasVector);
console.log("search 过滤已删测试: forget B 后 search B 不应出现");
s.forget(b.id);
const r1 = s.search({ query: "测试记忆B", limit: 5, queryVector: null, keywordFallback: true });
console.log("search '测试记忆B' 命中(应为0):", r1.results.length);
s.restore(b.id);
const r2 = s.search({ query: "测试记忆B", limit: 5, keywordFallback: true });
console.log("restore 后 search 命中(应>0):", r2.results.length);
const bk = s.backup("/tmp/memtest/backup.sqlite");
console.log("backup:", bk);
const st = s.stats();
console.log("stats:", JSON.stringify({ total: st.total, deleted: st.deleted, vectorized: st.vectorized }));
console.log("purge B(硬删):", s.forget(b.id, { soft: false }));
console.log("purge 后 list:", s.list({ limit: 10 }).map(r => r.text).join(" | "));
s.close();
console.log("ALL STORE TESTS PASSED");
