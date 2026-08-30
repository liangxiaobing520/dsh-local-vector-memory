# dsh-local-vector-memory

本地向量记忆插件 for DeepSeek Harness(DSH)。本地 embedding 向量化 + SQLite 单文件存储,对话自动召回注入;会话结束由 DeepSeek 云端 deepseek-v4-pro 自动提取。

*A local-first vector memory plugin for DeepSeek Harness: local embeddings, SQLite storage, automatic recall injection, and DeepSeek cloud v4-pro extraction at session flush.*

## 特性

- **写入三条路**:手动 `memory_add`;用户消息命中记忆线索(记住/以后/偏好/约定/不要…)时毫秒级自动捕获;DeepSeek 云端 deepseek-v4-pro 在会话结束时从整段对话提取记忆(`autoExtract`,默认开)
- **防矛盾记忆**:写入时检测与已有记忆的冲突/过时(相似度 ≥0.86 但未达完全重复),提示改用 `memory_update` 更新旧记忆而不是新增重复条目
- **回收站**:`memory_forget` 默认软删除,`memory_restore` 可恢复;`purge=true` 才永久删除
- **在线备份**:`memory_backup` 用 SQLite `VACUUM INTO` 生成一致性快照(安全于手工复制 WAL 库),默认保留 5 份
- **自动召回**:每次 agent 推理前检索 top-K 相关记忆注入上下文(`<local-memory>` 标签),会话内 LRU 去重
- **批量向量化**:提取/重建索引一次 HTTP 批量请求,失败自动逐条回退
- **关键词兜底**:embedding 服务不可用时退化为中英文关键词匹配,写入照常
- **本地存储**:向量库是单个 SQLite 文件(`node:sqlite`,Node ≥22.5);embedding 全本地,提取走 DeepSeek 云端

## 需求

- DSH(DeepSeek Harness),web profile
- Node.js ≥ 22.5(内置 `node:sqlite`)
- OpenAI 兼容的本地 embedding 服务(见下文,推荐 Qwen3-Embedding-0.6B + llama-server)
- DeepSeek 官方云端 API(`deepseek-v4-pro`)用于提取;API key 配置在 cordis.patch.yml

## 安装

```bash
dsh plugin --profile web add dsh-local-vector-memory
```

插件声明 `dsh.bundle.patch`,安装后 `dsh.profile.bundles` 自动追加,无需手改 package.json。重启 DSH Web 生效。

## 工具(10 个)

| 工具 | 作用 |
| --- | --- |
| `memory_add` | 写入一条长期记忆(用户说"记住…"时;自动去重 + 冲突检测) |
| `memory_search` | 向量检索(embedding 挂了自动关键词兜底;支持 tag 过滤) |
| `memory_list` | 浏览记忆,支持 tag/source 过滤;`includeDeleted=true` 看回收站 |
| `memory_update` | 按 id 更新文本/标签(自动重向量化),纠正过时/冲突记忆 |
| `memory_forget` | 按 id 删除,默认软删除(可恢复);`purge=true` 永久删除 |
| `memory_restore` | 恢复被软删除的记忆(回收站) |
| `memory_backup` | SQLite 在线备份到 `~/.dsh/backups/memory`,自动保留最近 5 份 |
| `memory_stats` | 库状态 + 软删除数 + 服务地址 |
| `memory_reindex` | 给未向量化条目补向量(批量) |
| `memory_extract` | 让本地 9B 从一段文本提炼记忆入库(仅短文本) |

## 默认配置

全部默认值在 `lib/config.mjs`。覆盖方式:在 `~/.dsh/profiles/web/cordis.patch.yml` 写:

```yaml
- id: local-vector-memory
  config:
    autoRecall: true
    recallTopK: 6
    recallMinScore: 0.55
    autoExtract: false   # 可选实验项;Qwythos 长文本思考链很长,谨慎开启
    autoCapture: true    # 用户消息命中"记住/以后/偏好/约定/不要"等线索时自动入库
    skipDuplicates: true # 相同/高度相似记忆跳过
    softDelete: true     # memory_forget 默认软删除(回收站)
    backupDir: ~/.dsh/backups/memory
    backupKeep: 5
    conflictScore: 0.86  # 相似度 >= 此值(未达完全重复)提示冲突、建议 memory_update
    recallDedupeLru: 16  # 会话内召回去重 LRU 上限
    embeddingEndpoint: auto      # auto = WSL 网关 + embeddingPort
    embeddingPort: 8081
    extractionEndpoint: auto     # auto = WSL 网关 + extractionPort
    extractionPort: 8080
```

注意 DSH patch 是整段替换,不是深合并;上例只写了要改的字段,其余回到默认值。

## 配套 embedding 服务(独立于插件)

模型下载(一次):

```bash
modelscope download --model Qwen/Qwen3-Embedding-0.6B-GGUF \
  Qwen3-Embedding-0.6B-Q8_0.gguf --local-dir /mnt/e/models
```

Windows 启动脚本 `E:\llama\start-embedding.ps1`:

```powershell
Start-Process -FilePath 'E:\llama\llama-embed.exe' -ArgumentList @(
  '-m','E:\models\Qwen3-Embedding-0.6B-Q8_0.gguf',
  '--embeddings','--pooling','mean','-c','8192',
  '--host','0.0.0.0','--port','8081','-ngl','0'
) -WindowStyle Hidden -RedirectStandardOutput 'E:\llama\embedding-server.log' -RedirectStandardError 'E:\llama\embedding-server.err.log' -PassThru
```

验证:

```bash
curl http://172.30.48.1:8081/v1/embeddings \
  -H 'Content-Type: application/json' \
  -d '{"model":"local-embedding","input":"测试"}'
```

## 数据流

```
用户消息 ──记忆线索命中?──▶ embedding(8081) ──▶ SQLite 向量库
memory_add ─────────────────────────────▶ embedding(8081) ──▶ SQLite 向量库
memory_extract ──▶ 本地 9B(8080,仅短文本) ──▶ 批量 embedding ──▶ SQLite 向量库
                                                       │
                 agent/pre-step 自动召回 ◀──────────────┘
```

## 故障排查

- `memory_stats` 显示未向量化很多:检查 8081 服务,然后 `memory_reindex`。
- 自动提取没发生:`autoExtract` 默认关闭。Qwythos 是长思考链模型,长文本提取会耗尽 max_tokens(实测),所以默认改用线索自动捕获;短文本可手动 `memory_extract`。
- DSH 日志过滤:`[dsh-local-vector-memory]`。
- WSL 重启后网关变化:插件自动探测默认网关;若 8081/8080 不通,先确认 Windows 侧服务在跑。

## License

MIT
