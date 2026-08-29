import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";

/**
 * 解析 DSH 运行时 peer 依赖(@deepseek-ai/dsh-tools / dsh-llm)。
 * 标准安装时插件位于 profiles/<name>/node_modules 下,Node 会沿父目录找到
 * profiles/node_modules;本地路径/symlink 安装时 Node 跟随 realpath,因此
 * 这里显式补充 $DSH_HOME/profiles/node_modules 兜底。
 */
function requireCandidates() {
  const out = [];
  try {
    out.push(createRequire(import.meta.url));
  } catch {
    // ignore
  }
  const home = process.env.HOME ?? homedir();
  const dshHome = process.env.DSH_HOME ?? join(home, ".dsh");
  for (const base of [
    join(dshHome, "profiles", "node_modules"),
    join(dshHome, "node_modules"),
  ]) {
    const anchor = join(base, "@deepseek-ai", "placeholder", "package.json");
    try {
      out.push(createRequire(anchor));
    } catch {
      // ignore
    }
  }
  // 从插件真实路径向上找 node_modules(覆盖 junction 安装在别处的情况)
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (;;) {
      const anchor = join(dir, "node_modules", "@deepseek-ai", "placeholder", "package.json");
      if (existsSync(anchor)) {
        out.push(createRequire(anchor));
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // ignore
  }
  return out;
}

export async function loadPeer(packageName, exportName) {
  const errors = [];
  for (const req of requireCandidates()) {
    try {
      const resolved = req.resolve(packageName);
      try {
        const mod = req(resolved);
        if (exportName === "default") return mod.default ?? mod;
        if (exportName in mod) return mod[exportName];
        return mod;
      } catch {
        const mod = await import(pathToFileURL(resolved).href);
        if (exportName === "default") return mod.default ?? mod;
        if (exportName in mod) return mod[exportName];
        return mod;
      }
    } catch (error) {
      errors.push(String(error?.message || error));
    }
  }
  throw new Error(
    `[dsh-local-vector-memory] cannot resolve peer "${packageName}" from DSH runtime. ` +
      `Install via \`dsh plugin add\` so peer dependencies resolve automatically. Details: ${errors.join(" | ")}`,
  );
}

let defineToolPromise;
export function loadDefineTool() {
  if (!defineToolPromise) {
    defineToolPromise = loadPeer("@deepseek-ai/dsh-tools", "defineTool").catch((error) => {
      defineToolPromise = null;
      throw error;
    });
  }
  return defineToolPromise;
}

let createUserMessagePromise;
export function loadCreateUserMessage() {
  if (!createUserMessagePromise) {
    createUserMessagePromise = loadPeer("@deepseek-ai/dsh-llm", "createUserMessage").catch((error) => {
      createUserMessagePromise = null;
      throw error;
    });
  }
  return createUserMessagePromise;
}
