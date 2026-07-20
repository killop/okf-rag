<h1 align="center">okf-rag</h1>

<p align="center">
  <strong>把 Raw Markdown 自动转成去重、互联的 OKF 知识，并通过 MCP 在本地检索。</strong>
  <br />
  <em>llm-wiki 生产流水线 · Rust 消费运行时 · 本地 MiniLM · zvec 混合检索</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Rust-1.88%2B-000000?style=flat&logo=rust&logoColor=white" alt="Rust 1.88+" />
  <img src="https://img.shields.io/badge/Protocol-MCP-2563EB?style=flat" alt="MCP" />
  <img src="https://img.shields.io/badge/Embedding-Local_MiniLM-10B981?style=flat" alt="Local MiniLM" />
  <img src="https://img.shields.io/badge/Vector_Index-zvec-8B5CF6?style=flat" alt="zvec" />
  <img src="https://img.shields.io/badge/Runtime-Windows_x64-0078D4?style=flat&logo=windows&logoColor=white" alt="Windows x64" />
  <a href="https://github.com/killop/okf-rag/actions/workflows/ci.yml"><img src="https://github.com/killop/okf-rag/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/killop/okf-rag" alt="Apache-2.0" /></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>中文</strong>
</p>

## 核心能力

| 能力 | 作用 |
|---|---|
| Markdown truth | OKF v0.1 concept 文件保持可读、可 diff、可迁移，不依赖 vector index 才能解释。 |
| 自动知识生产 | supervisor daemon 把 Raw Markdown 交给 `llm-wiki-compiler`，再执行 ownership reconcile、exact dedupe、关系抽取、校验和原子发布。 |
| Wiki 知识图 | Obsidian wikilink、有向 relation、incoming backlink、confidence 和 evidence 一起进入 concept 与 manifest，不伪造反向语义边。 |
| 本地检索 | Rust 使用本地 ONNX MiniLM、embedding cache、zvec vector/full-text 字段和 lexical rerank，不调用远程 embedding API。 |
| 非阻塞增量更新 | MCP 先完成 `initialize` 和 `tools/list`，再启动 watcher；后台只重建 inactive A/B slot，查询继续读取 active slot。 |
| 便携 Agent 集成 | 包含项目级 MCP、workspace-local runtime、skill、stream-only OpenAI 适配、rollback snapshot 和 workspace mirror。 |

## 快速开始

### 构建运行时

```powershell
git clone https://github.com/killop/okf-rag.git
Set-Location okf-rag
cargo build -p okf-rag --release
```

使用 release 包时可以跳过这一步，直接使用包内可执行程序。

从源码安装时还需要先准备本地 embedding 模型：

```powershell
python -m pip install "huggingface-hub>=1.5"
hf download sentence-transformers/all-MiniLM-L6-v2 tokenizer.json onnx/model.onnx `
  --local-dir .okf-rag/models/all-MiniLM-L6-v2
```

Release 包可以直接包含该模型，因此不需要执行下载步骤。

### 安装到项目工作区

```powershell
$WORKDIR = "F:\path\to\your-project"
node scripts\setup_okf_rag_workspace.js --target $WORKDIR --runtime-source target\release
Set-Location $WORKDIR
```

### 建立初始本地索引

```powershell
okf-rag-workspace\bin\okf-rag.exe ingest --root . --force
okf-rag-workspace\bin\okf-rag.exe query --root . "domain memory zvec" --top-k 5 --candidate-k 50
```

### 启动 Raw Markdown 自动消化

```powershell
node okf-rag-workspace\tools\okf_llmwiki_daemon.js start `
  --bundle project-knowledge
```

把 `.md` 放进 `okf-rag-workspace/raw/project-knowledge/`。daemon 成功后会发布 `okf-rag-workspace/okfs/project-knowledge/`，并自动运行 Rust ingest。

## ASCII 架构图

`okf-rag` 把知识生产和本地知识消费分开：Node/LLM 平面只负责提出并协调 OKF，Rust 平面只索引已经发布的 Markdown truth。

### 端到端知识流水线

```text
+---------------------------- Producer plane: Node + LLM -----------------------------+
|                                                                                      |
|  Agent / user                                                                        |
|      |                                                                               |
|      v                                                                               |
|  raw/<topic>/*.md                                                                    |
|      |  fs.watch + debounce                                                          |
|      v                                                                               |
|  daemon supervisor -> worker -> source manifest v2                                  |
|                                      |                                               |
|                                      v                                               |
|                         llm-wiki-compiler candidates + links                         |
|                                      |                                               |
|                                      v                                               |
|  ownership/prune -> exact dedupe -> directed graph -> validate -> staged publish    |
|                                      |                                               |
+--------------------------------------|-----------------------------------------------+
                                       v
                     okfs/<topic>/index.md + concept Markdown
                                       |
+--------------------------------------|-----------------------------------------------+
|                       Consumer plane: Rust, local only                               |
|                                      v                                               |
|  ingest -> MiniLM ONNX -> embedding cache -> inactive zvec slot                     |
|                                                   | successful build                 |
|                                                   v                                  |
|  Codex / agent <- MCP query <- hybrid recall + lexical rerank <- active slot pointer |
|                                                                                      |
+--------------------------------------------------------------------------------------+
```

对于只接受 `stream: true` 的 OpenAI-compatible provider，`openai_stream_adapter.js` 在 loopback 上把 llmwiki 请求改写为上游流式请求，并重新聚合文本和 tool-call 响应。密钥只存在于环境变量，daemon state 和 diagnostics 会统一脱敏。

### MCP 启动与后台 A/B 更新

```text
Codex / MCP client          okf-rag MCP process         watcher thread         zvec
        |                           |                         |                   |
        |------ initialize -------> |                         |                   |
        | <---- initialize result - |                         |                   |
        |------ tools/list -------->|                         |                   |
        | <------- tool list -------|                         |                   |
        |                           |------ spawn ----------->|                   |
        |                           |                         | snapshot + diff   |
        |------ query ------------->|------------------------------ read active A |
        | <------- old truth -------|                         |                   |
        |                           |                         | debounce          |
        |                           |                         | ingest.lock       |
        |                           |                         |---- build B ----->|
        |------ query ------------->|------------------------------ read active A |
        |                           |                         |                   |
        |                           |                         | atomic switch A->B|
        |------ query ------------->|------------------------------ read active B |
```

自动 refresh 是后台任务；显式 `okf_rag_ingest` 仍然同步执行，因为调用者需要拿到明确的完成结果。

### 工作区与状态边界

```text
project-root/
|
+-- .codex/config.toml                    项目级 MCP 注册
+-- .agents/skills/okf-rag-okf-format/   Agent 指令和 OKF spec reference
+-- okf-rag-workspace/
|   +-- raw/<topic>/*.md                  daemon 输入
|   +-- okfs/
|   |   +-- index.md                      bundle 总目录，不是 concept truth
|   |   +-- <topic>/
|   |       +-- index.md                  progressive disclosure
|   |       +-- overview.md               concept truth
|   |       +-- <concept>.md              concept truth 和有向链接
|   +-- bin/                               okf-rag.exe 和 native DLL
|   +-- tools/                             pipeline、daemon、maintenance、benchmark
|
+-- .okf-rag/                             可删除的派生/运行状态
    +-- models/all-MiniLM-L6-v2/          本地 embedding model
    +-- index/zvec-a|zvec-b/               A/B index
    +-- cache/embeddings/                  content-addressed embedding cache
    +-- llmwiki-projects|exports|sync/     compiler 和 reconcile 状态
    +-- generations/<topic>/               最近五个 rollback snapshot
    +-- llmwiki-daemon/                    PID、heartbeat、stage、error、log
```

### 组件职责

| 组件 | 职责 |
|---|---|
| `okf_llmwiki_daemon.js` | 监听 topic inbox，监管 worker，合并频繁变更，提供状态并重复运行完整 bridge。 |
| `compile_okf_with_llmwiki.js` | 同步 Raw Markdown，管理持久 llmwiki runtime/project，导出 candidate，协调 ownership/duplicate，校验、发布、mirror 并调用 ingest。 |
| `openai_stream_adapter.js` | 把 llmwiki 的非流式调用适配到只接受 `stream: true` 的上游，包括流式 tool call。 |
| `okf_maintain.js` / `okf_relationships.js` | 校验 OKF、刷新 index、审计 duplicate/orphan，并生成有 evidence 的有向关系。 |
| Rust `okf-rag` | 解析 OKF、本地 embedding、构建 zvec A/B index，并提供 CLI/MCP status、ingest、query、bench。 |
| zvec | 保存 vector 和可检索 metadata，支持 hybrid recall 与本地 rerank。 |

## 目录约定

- `.okf-rag/`：临时运行状态，可以删除，里面可能有过期索引、报告、缓存、本地模型状态、watcher 状态。
- `okf-rag-workspace/`：用户工作目录和 runtime 安装位置。OKF Markdown truth 文件放在 `okf-rag-workspace/okfs/`，workspace-local 可执行程序放在 `okf-rag-workspace/bin/`。

做 setup demo 或交给另一个 agent 时，只需要把两个 workspace 目录一起复制：

```text
.okf-rag/
okf-rag-workspace/
```

Rust 源码仓库就是 clone 下来的 `okf-rag` repo 本身，不要在用户工作目录里再创建一层 `okf-rag/`。`.okf-rag/` 作为目录骨架保留，但里面生成出来的索引、缓存、状态都是可删除的。复制后用 `okf-rag ingest --force` 重建。

正式发布包还必须带上预编译 Windows runtime，避免用户二次编译：

```text
okf-rag-workspace/bin/okf-rag.exe
okf-rag-workspace/bin/onnxruntime.dll
okf-rag-workspace/bin/onnxruntime_providers_shared.dll
okf-rag-workspace/bin/zvec_c_api.dll
```

## 项目结构

```text
crates/okf-rag/                     Rust CLI、MCP server、MiniLM 和 zvec runtime
scripts/                            producer pipeline、daemon、reconcile、test、benchmark
skills/okf-rag-okf-format/          可安装 Agent skill 和内置 OKF v0.1 reference
okf-rag-workspace/
|-- raw/                            默认 daemon inbox 根目录
|-- okfs/                           可提交的 OKF Markdown truth
|-- bin/                            便携 exe 和 native DLL
`-- tools/                          安装到目标工作区的脚本
third_party/
|-- zvec-rust/                      vendored Rust binding
|-- zvec-prebuilt-x86_64-pc-windows-msvc/
`-- onnxruntime/                    native ONNX Runtime 文件
data/                               retrieval benchmark corpus 和 eval set
OKF-RAG-BENCHMARK.md                benchmark 方法与实测结果
setup-for-agent.md                  项目级安装与 MCP contract
```

## 技术栈

| 层 | 技术 | 作用 |
|---|---|---|
| 知识格式 | OKF v0.1 Markdown + YAML frontmatter | 保存可迁移 concept truth、index、citation 和标准 Markdown link。 |
| Producer runtime | Node.js、便携 Node 24 runtime | pipeline 编排、daemon 监管、manifest、校验、原子发布和 mirror。 |
| Semantic producer | `llm-wiki-compiler@1.1.0` | 从 Raw Markdown 抽取 candidate concept 和显式 link。 |
| LLM compatibility | OpenAI-compatible streaming adapter | 支持只接受流式文本和 tool call 的上游 API。 |
| Consumer runtime | Rust 1.88+ | CLI、stdio MCP、本地 ingest/query、watcher、lock 和 benchmark。 |
| Embedding | ONNX Runtime + `all-MiniLM-L6-v2` | 本地 384 维语义 embedding、动态 padding 和 cache。 |
| Retrieval | zvec | 保存 vector 和可检索 metadata，执行 hybrid retrieval。 |
| Agent integration | Model Context Protocol | 提供项目级 status、ingest 和 query tool。 |

## 构建

```powershell
cargo build -p okf-rag --release
```

本地 zvec Rust binding 和 native runtime 依赖已经放在：

```text
third_party/zvec-rust/
third_party/zvec-prebuilt-x86_64-pc-windows-msvc/
third_party/onnxruntime/
```

## 发布包

发布时由维护者先构建一次，然后把 release exe 和必需 DLL 一起打包：

```powershell
node scripts/package_okf_rag_release.js
```

发布包输出到 `dist/`，包含文档、`okf-rag-workspace/`、`.okf-rag` 骨架、本地模型文件（如果存在）以及 `okf-rag-workspace/bin/okf-rag.exe`。

用户解压到新机器后，用包内 exe 建一次当前目录的本地索引即可，不需要 Rust 或 Cargo：

```powershell
okf-rag-workspace\bin\okf-rag.exe ingest --force
```

发布脚本不创建、不修改项目级 Codex 配置。Codex MCP 配置只在 [setup-for-agent.md](setup-for-agent.md) 里说明，由用户或 agent 手动放置。

## Clone 后 Setup

在当前 agent 正在工作的项目根目录初始化 OKF-RAG：

```powershell
$WORKDIR = (Get-Location).Path
node scripts/setup_okf_rag_workspace.js --target $WORKDIR
```

setup 脚本不允许省略 `--target`，并且默认拒绝安装到 `okf-rag` 源码 repo。给别的项目安装时，不要把 `--target` 指向源码 repo。这个脚本会创建缺失的运行/工作目录，在安装源包含模型时复制 MiniLM 模型，清掉旧的非 MiniLM 派生索引状态，把 OKF skill 安装到 `.agents/skills/`，把 pipeline/daemon/maintenance/benchmark 工具安装到 `okf-rag-workspace/tools/`，创建只写一次的 `.okf-rag/INSTRUCTIONS.md`，并使用受管 marker 更新 `AGENTS.md`、`CLAUDE.md` 和 `.gitignore`。它不会创建也不会修改 `.codex/config.toml`；直接复制 [setup-for-agent.md](setup-for-agent.md) 里的 TOML 片段。

安装完成后，项目内 agent 使用 `node okf-rag-workspace/tools/okf_pipeline.js ...`，不需要依赖 OKF-RAG 源码 repo 的 `scripts/` 目录。

## CLI

```powershell
okf-rag-workspace\bin\okf-rag.exe init
okf-rag-workspace\bin\okf-rag.exe ingest
okf-rag-workspace\bin\okf-rag.exe ingest --force
okf-rag-workspace\bin\okf-rag.exe query "domain driven memory zvec" --top-k 5 --candidate-k 50
okf-rag-workspace\bin\okf-rag.exe status
okf-rag-workspace\bin\okf-rag.exe bench data\okf-memory-benchmark\okf-hybrid-20260623-211957\eval.json --top-k 10 --candidate-k 100
```

不传 `SOURCE_DIR` 时，`ingest` 默认读取：

```text
okf-rag-workspace/okfs
```

## 用 llm-wiki-compiler 生成 OKF

OKF 自动生成采用 proposal-to-truth 流水线：`llm-wiki-compiler` 负责抽取候选概念，OKF reconciler 根据 llmwiki 的 source-to-concept state 做所有权、权威清理、保守去重和 Wiki 链接，Rust `okf-rag` 负责消化最终 Markdown、建本地索引和查询。llmwiki 不再直接决定最终文件集合。

推荐入口是一条完整流水线命令：

```powershell
node scripts/okf_pipeline.js --source <markdown-file-or-directory> --bundle <topic-slug>
```

本地 Markdown 文件和目录会先按照 `llm-wiki-compiler/SOURCES_CONTRACT.md` 稳定同步到 llmwiki 的 `sources/`。未变化的文件保持字节不变，删除的原始文件会从受管控的 `sources/` 中移除。完全无变化且已存在有效 generation 时会 fast-skip，不启动 llmwiki/provider。

脚本会把 llmwiki 的项目状态放在 `.okf-rag/llmwiki-projects/<topic-slug>/`，把导出的 OKF 暂存到 `.okf-rag/llmwiki-exports/<topic-slug>/`，然后同步到：

```text
okf-rag-workspace/okfs/<topic-slug>/
```

发布前先在 `.okf-rag/publish-staging/` 生成完整候选 bundle，执行权威 prune、exact dedupe、有向关系生成、断链校验和图审计，再原子切换到目标 topic 文件夹。修改过的历史生成文件不会直接丢失；删除时会归档到 bundle 的 `references/recovered/`，Rust 不会索引该目录。

每个最终概念都会增加 `okf_bundle`、`okf_generation`、`canonical_id`、`source_refs`、`aliases`、`outbound_relations` 和 `inbound_relations`。关系从 llmwiki 的显式 Markdown 链接及其上下文中提取，语义边保持有向；目标概念会生成导航 backlink，但不会伪造反向语义边。`## Related Concepts` 使用 Obsidian `[[文件名|标题]]`，分别展示 Outgoing 和 Backlinks。`source_refs` 只使用 bundle 内 `references/` 的相对路径，reference source 使用 `okf-source://`；发布校验会拒绝 Windows 盘符、UNC 和绝对 `file:///` 路径。同步 manifest v3 位于 `.okf-rag/llmwiki-sync/<topic-slug>.json`，记录 source ownership、关系图、orphan、重复候选、文件 hash 和 generation。topic bundle 的 `index.md` 声明 `okf_version: "0.1"`，`okfs/index.md` 作为所有 bundle 的确定性目录；`okf-rag-workspace/index.md` 不生成。

本地 Markdown source manifest v2 位于 `.okf-rag/llmwiki-source-sync/<topic-slug>.json`，记录 adapter、稳定的 source instance、原始内容 hash、compiler source hash、变更和删除。仅修改 mtime 而不修改内容不会重写 llmwiki source。daemon、provider 和 stream adapter 的错误输出会经过统一脱敏后再写入日志或状态文件。

完整数据流是：

```text
raw Markdown -> source manifests -> llmwiki concepts/links -> directed OKF graph reconcile -> staged publish -> Rust MiniLM -> zvec
```

llmwiki 1.1.0 要求 Node 24。当前脚本会在 `.okf-rag/llmwiki-runtime/` 自动安装并复用 `node@24.16.0`、`llm-wiki-compiler@1.1.0` 和平台运行依赖，不要求把系统 Node 全局升级。provider 既可以通过环境变量设置，也可以直接传入：

```powershell
claude auth login
$env:LLMWIKI_PROVIDER = "claude-agent"
node scripts/okf_pipeline.js --source E:\repo\docs --bundle repo-docs --concurrency 3
```

`claude-agent` 启动前会检查 Claude Code 登录状态；未登录时会立即提示，不会进入 LLM 重试循环。也可以使用 `anthropic`、`openai`、`ollama` 等 llmwiki 原生 provider，并沿用它们的环境变量配置。

### Stream-only OpenAI-compatible Provider

只有 OpenAI-compatible `base URL + key`，而且上游只接受 `stream: true` 时，先把配置放在当前 PowerShell 进程中。不要把 key 写进命令参数：

```powershell
$env:OPENAI_BASE_URL = "https://your-gateway.example/v1"
$env:OPENAI_API_KEY = "your-secret-key"
$env:LLMWIKI_MODEL = "your-model-name"
```

先检查文本流和流式 tool call。llmwiki 的概念提取依赖 tool call，因此两项都必须通过：

```powershell
node scripts/openai_stream_adapter.js --probe
```

通过后启动完整流水线：

```powershell
node scripts/okf_pipeline.js `
  --source E:\repo\docs `
  --bundle repo-docs `
  --provider openai `
  --stream-only-openai `
  --concurrency 1
```

stream adapter 只监听 `127.0.0.1`，把 llmwiki 的非流式 completion/tool-call 请求改写为上游流式请求，并把 SSE 聚合回标准 OpenAI JSON。上游没有 embeddings API 时，llmwiki 会跳过自身语义 embedding；最终 zvec embedding 仍由 Rust 本地 MiniLM 完成。

只验证 raw Markdown 到 `sources/` 的同步契约，不调用 LLM：

```powershell
node scripts/okf_pipeline.js --source E:\repo\docs --bundle repo-docs --stage-only
```

给 U3D 工程同步现成 workspace 时加：

```powershell
node scripts/okf_pipeline.js --source <file-or-directory> --bundle <topic-slug> --mirror-workspace F:\path\to\target-project\okf-rag-workspace
```

如果 `okf-rag-workspace/bin` 还没有 runtime，mirror 前会从 `target/release` 复制 `okf-rag.exe` 和必需 DLL；所以第一次使用 mirror 前先跑一次 `cargo build -p okf-rag --release`。

### Daemon 和 Raw Inbox

`llm-wiki-compiler` 原生有 `llmwiki watch` 和 `llmwiki serve`，但前者只重编译 `wiki/`，后者是 MCP stdio server；它们不会自动 `export --target okf`、同步 `okf-rag-workspace/okfs`、再触发 Rust ingest。OKF-RAG 这边用守护脚本补齐这个闭环：

```powershell
node scripts/okf_llmwiki_daemon.js run --bundle <topic-slug>
```

省略 `--source` 时，daemon 会自动创建并递归监听：

```text
okf-rag-workspace/raw/<topic-slug>/
```

Agent 或用户只需要在这个 Raw Inbox 中新增、修改或删除 `.md` 文件。变更经过 debounce 后会自动执行 raw source 同步、llmwiki 编译、OKF 去重与关系协调、原子发布以及 Rust ingest。daemon 还会定期对照 sync manifest 检查受管输出；整个 topic 目录、`index.md` 或任一受管概念被删除时，会以 30 秒退避在后台排队恢复。`okfs/<topic-slug>/` 是 daemon 管理的生成结果，不应再作为 Raw 输入直接修改。

后台启动、查看、停止：

```powershell
node scripts/okf_llmwiki_daemon.js start --bundle <topic-slug>
node scripts/okf_llmwiki_daemon.js status --bundle <topic-slug>
node scripts/okf_llmwiki_daemon.js stop --bundle <topic-slug>
```

导入已有路径时仍可显式传入 `--source <file-or-directory>`；自定义 Inbox 可使用 `--inbox <directory>`，二者不能同时使用。后台 `start` 会启动 supervisor 和 worker。worker 异常退出时 supervisor 使用递增退避自动拉起；`status --json` 返回 supervisor/worker PID、Raw Inbox、source paths、heartbeat、watch targets、pending reason、当前 pipeline stage、最近一次耗时和错误。日志、PID 和状态文件都在 `.okf-rag/llmwiki-daemon/`。

### Rollback 和 Workspace Mirror

每次成功发布会保留最近 5 个本地 generation snapshot：

```powershell
node scripts/okf_generation.js list --bundle <topic-slug>
node scripts/okf_generation.js rollback --bundle <topic-slug> --generation <generation-id>
```

rollback 使用同样的原子目录切换，并默认重新运行 Rust ingest。generation snapshot 位于 `.okf-rag/generations/`，属于可删除的派生恢复点，OKF Markdown 仍是 truth。

pipeline 或 daemon 传入 `--mirror-workspace <directory>` 后，会在成功发布后把准备好的 runtime、tools 和 OKF workspace 同步到另一个项目。

Rust ingest 会把 `type`、`okf_bundle`、`canonical_id`、`okf_generation`、`source_document`、`section_path`、`aliases`、`source_refs`、`outbound_relations` 和 `inbound_relations` 一并写入 zvec。`okf_rag_query` 的命中结果会返回这些字段，并附带本地 `route_trace`；`okf_rag_relationships` 可按 canonical ID、标题、URI 或 alias 直接查看出站关系和入站 backlink。查询热路径仍然只使用本地 MiniLM、zvec 和词法重排，不增加远程 LLM 调用。

## 配置

项目级大模型配置放在这个被 Git 忽略的文件中：

```text
.okf-rag/llmwiki.env
```

setup 会生成 `.okf-rag/llmwiki.env.example`。pipeline、daemon 和 `openai_stream_adapter.js --probe` 都会从项目根目录自动加载实际配置；当前进程显式设置的环境变量优先。这个文件不会被 `--mirror-workspace` 复制，不会发布成 OKF 知识，daemon status 也永远不会返回其中的值。

```dotenv
LLMWIKI_PROVIDER=openai
OPENAI_BASE_URL=https://your-gateway.example/v1
OPENAI_API_KEY=your-secret-key
LLMWIKI_MODEL=your-model-name
LLMWIKI_STREAM_ONLY_OPENAI=true
LLMWIKI_OUTPUT_LANG=Chinese
LLMWIKI_COMPILE_CONCURRENCY=1
```

| 环境变量 | 使用方 | 作用 | 默认值 |
|---|---|---|---|
| `LLMWIKI_PROVIDER` | Pipeline/daemon | llmwiki provider，例如 `claude-agent`、`openai`、`ollama`。 | 由 provider 决定 |
| `LLMWIKI_MODEL` | Pipeline/adapter | concept 抽取和 stream probe 使用的模型。 | 由 provider 要求 |
| `OPENAI_BASE_URL` | Stream adapter | OpenAI-compatible 上游 base URL。 | 无 |
| `OPENAI_API_KEY` | Stream adapter | 上游凭据；不要放进命令参数或 Markdown。 | 无 |
| `LLMWIKI_STREAM_ONLY_OPENAI` | Pipeline/daemon | 为只接受 `stream: true` 的上游启用 loopback adapter。 | `false` |
| `LLMWIKI_OUTPUT_LANG` | Pipeline/daemon | 生成 wiki 的语言。 | `Chinese` |
| `LLMWIKI_COMPILE_CONCURRENCY` | Pipeline/daemon | llmwiki 最大并发 LLM 调用数。 | llmwiki 默认值 |
| `OKF_RAG_MIRROR_WORKSPACE` | Pipeline/daemon | 成功发布后复制到的 workspace。 | 关闭 |
| `OKF_RAG_ONNX_BATCH_SIZE` | Rust ingest | MiniLM embedding batch size。 | runtime 默认值 |
| `OKF_RAG_ONNX_THREADS` | Rust ingest/query | ONNX intra-op thread 数。 | runtime 默认值 |

## Benchmark

2026-06-24 的 release benchmark：本地 `minilm-l6-v2-onnx`，本地 zvec，53 个 OKF Markdown concepts，258 条 queries，`top-k=10`，有效 `candidate-k=53`。

| 指标 | 结果 |
|---|---:|
| Recall@1 / Hit@1 | 0.9535 |
| Recall@3 / Hit@3 | 0.9845 |
| Recall@5 / Hit@5 | 0.9922 |
| Recall@10 / Hit@10 | 1.0000 |
| MRR@10 | 0.9700 |

Hot query path 会先加载一次 ONNX 和 zvec，然后连续跑全部 queries：

| 阶段 | Avg ms | P50 ms | P95 ms |
|---|---:|---:|---:|
| Total query | 5.327 | 5.280 | 6.285 |
| ONNX embedding | 3.474 | 3.419 | 4.355 |
| zvec + rerank | 1.853 | 1.845 | 2.016 |

Ingest benchmark：

| 运行方式 | Cache Hits | Cache Misses | Total ms |
|---|---:|---:|---:|
| Cold embedding cache, forced rebuild | 0 | 53 | 1834.119 |
| Warm embedding cache, forced rebuild | 53 | 0 | 190.061 |
| Unchanged source, skipped rebuild | 0 | 0 | 71.584 |

完整数据、query type breakdown 和 ONNX thread sweep 见 [OKF-RAG-BENCHMARK.md](OKF-RAG-BENCHMARK.md)。

## MCP

启动 stdio MCP server：

```powershell
okf-rag-workspace\bin\okf-rag.exe mcp --root .
```

安装 MCP 配置时，默认写到当前项目的 Codex 配置：

```text
<WORKDIR>\.codex\config.toml
```

不要把这个项目的 MCP 配置写到用户级 Codex 配置，除非你明确要全局安装：

```text
C:\Users\<USER>\.codex\config.toml
```

项目级安装只在当前 workspace 生效，不会污染其他 Codex 会话。

推荐配置使用当前 workspace 的相对路径：

```toml
[mcp_servers.okf-rag]
type = "stdio"
command = ".\\okf-rag-workspace\\bin\\okf-rag.exe"
args = ["mcp", "--root", "."]
```

通用 MCP 配置：

```json
{
  "mcpServers": {
    "okf-rag": {
      "command": ".\\okf-rag-workspace\\bin\\okf-rag.exe",
      "args": ["mcp", "--root", "."]
    }
  }
}
```

工具：

- `okf_rag_status`：查看 workspace、active slot、索引路径、concept 数量、embedding provider。
- `okf_rag_ingest`：把 OKF Markdown 建到 inactive A/B zvec slot，成功后切成 active。
- `okf_rag_query`：在 active 本地索引上执行 full hybrid retrieval。hit 会返回路由/关系 metadata 和 `route_trace`；`retrieval_policy.mode = "mcp"` 会要求 Agent 继续通过 MCP refine 或读取返回路径，不再用 shell 重复搜索 corpus。
- `okf_rag_relationships`：按 canonical ID、concept path、精确标题、URI 或 alias 返回一个概念的 outgoing relations、incoming backlinks、邻居标题和 workspace 相对路径。

Agent 使用说明见 [setup-for-agent.md](setup-for-agent.md)。

## 热同步

`okf-rag mcp` 会先完成并 flush MCP `tools/list` 响应，然后才启动后台服务。它会扫描 `okf-rag-workspace/raw/<topic>/`，为包含 Markdown 的 topic 幂等启动 workspace-local llmwiki daemon；随后启动 OKF watcher。缺失的生成 bundle 由 daemon 自动恢复，已存在或后续变更的 OKF 则由 watcher 在 inactive zvec slot 中重建。上述工作都不计入 Codex 启动超时。只有明确要关闭自动生成和自动索引时才使用 `--no-watch`。

```powershell
okf-rag-workspace\bin\okf-rag.exe mcp --root .
okf-rag-workspace\bin\okf-rag.exe mcp --root . --no-watch
```

运行状态文件：

```text
.okf-rag/index/zvec-a/
.okf-rag/index/zvec-b/
.okf-rag/active-slot.json
.okf-rag/ingest-state.json
.okf-rag/watcher-state.json
.okf-rag/ingest.lock
```

watcher 会保存 source snapshot，用 `mtime + size` 做 diff，累计 pending changes，debounce 后在后台重建 inactive slot。查询在重建期间继续读取旧 active slot，成功后才原子切换；结束后会再 scan 一次，捕捉重建期间发生的新变化。`ingest.lock` 防止多个 MCP 或 CLI 进程同时重建。

## Embedding

运行时 embedding 使用本地 ONNX MiniLM：

```text
sentence-transformers/all-MiniLM-L6-v2
```

模型文件放在：

```text
.okf-rag/models/all-MiniLM-L6-v2/
```

`setup_okf_rag_workspace.js` 会在安装源包含该模型目录时，把它复制到目标 workspace。

`ingest`、`query`、`mcp` 不调用远程 embedding API。本地 ONNX MiniLM 是必需项，没有 hash embedding fallback。如果模型目录下缺少 `onnx/model.onnx` 或 `tokenizer.json`，建库和查询会直接报 setup 错误。

## 性能参数

```powershell
$env:OKF_RAG_ONNX_BATCH_SIZE = "16"
$env:OKF_RAG_ONNX_THREADS = "4"
```

MiniLM tokenizer 使用 batch-longest 动态 padding，最大截断长度 256 token。

## 验证

```powershell
cargo fmt
cargo test -p okf-rag
cargo clippy -p okf-rag --no-deps -- -D warnings
cargo build -p okf-rag --release
$SMOKE = Join-Path $env:TEMP "okf-rag-smoke"
node scripts/setup_okf_rag_workspace.js --target $SMOKE --runtime-source target\release
& "$SMOKE\okf-rag-workspace\bin\okf-rag.exe" ingest --root $SMOKE
& "$SMOKE\okf-rag-workspace\bin\okf-rag.exe" query --root $SMOKE "domain memory zvec" --top-k 5 --candidate-k 50
```

## Ignore 规则

运行期生成文件不进源码管理，但 demo OKF truth 要保留：

```gitignore
/.okf-rag/
/okf-rag-workspace/bin/*
!/okf-rag-workspace/bin/README.md
/okf-rag-workspace/raw/*
!/okf-rag-workspace/raw/.gitkeep
```

不要忽略 `okf-rag-workspace/okfs/`；它保存可迁移的 Markdown truth 和 demo。运行时二进制应进入生成的 release 包，而不是重复提交到 Git。

## 贡献与安全

开发检查见 [CONTRIBUTING.md](CONTRIBUTING.md)，私下报告漏洞和密钥处理规则见 [SECURITY.md](SECURITY.md)。

## 许可证

okf-rag 使用 [Apache License 2.0](LICENSE)。Vendored 依赖声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
