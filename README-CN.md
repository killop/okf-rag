# okf-rag

本地优先的 OKF 检索系统，Markdown 是唯一 truth。

`okf-rag` 是 Rust CLI 和 stdio MCP server。它用本地 ONNX MiniLM 生成 embedding，用 zvec 建索引，并向 agent 提供 hybrid retrieval。

## 目录约定

- `.okf-rag/`：临时运行状态，可以删除，里面可能有过期索引、报告、缓存、本地模型状态、watcher 状态。
- `okf-rag/`：以后发布到 GitHub 的 Rust 源码仓库名。
- `okf-rag-workspace/`：用户工作目录。默认 OKF Markdown truth 文件放在 `okf-rag-workspace/okfs/`。

做 setup demo 或交给另一个 agent 时，要把三个核心目录一起复制：

```text
.okf-rag/
okf-rag/
okf-rag-workspace/
```

`.okf-rag/` 作为目录骨架保留，但里面生成出来的索引、缓存、状态都是可删除的。复制后用 `okf-rag ingest --force` 重建。

正式发布包还必须带上预编译 Windows runtime，避免用户二次编译：

```text
target/release/okf-rag.exe
target/release/onnxruntime.dll
target/release/onnxruntime_providers_shared.dll
target/release/zvec_c_api.dll
```

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

发布包输出到 `dist/`，包含文档、`okf-rag-workspace/`、`.okf-rag` 骨架、本地模型文件（如果存在）以及 `target/release/okf-rag.exe`。

用户解压到新机器后，用包内 exe 建一次当前目录的本地索引即可，不需要 Rust 或 Cargo：

```powershell
target\release\okf-rag.exe ingest --force
```

发布脚本不创建、不修改项目级 Codex 配置。Codex MCP 配置只在 [setup-for-agent.md](setup-for-agent.md) 里说明，由用户或 agent 手动放置。

## Clone 后 Setup

`git clone` 后初始化本地目录骨架：

```powershell
node scripts/setup_okf_rag_workspace.js
```

这个脚本只创建缺失的运行/工作目录、demo OKF 和占位 Markdown，不创建也不修改机器本地的 `.codex/config.toml`。请用 `.codex/config.toml.example` 作为模板。

## CLI

```powershell
target\release\okf-rag.exe init
target\release\okf-rag.exe ingest
target\release\okf-rag.exe ingest --force
target\release\okf-rag.exe query "domain driven memory zvec" --top-k 5 --candidate-k 50
target\release\okf-rag.exe status
target\release\okf-rag.exe bench data\okf-memory-benchmark\okf-hybrid-20260623-211957\eval.json --top-k 10 --candidate-k 100
```

不传 `SOURCE_DIR` 时，`ingest` 默认读取：

```text
okf-rag-workspace/okfs
```

## MCP

启动 stdio MCP server：

```powershell
target\release\okf-rag.exe mcp --root .
```

安装 MCP 配置时，默认写到当前项目的 Codex 配置：

```text
<CLONE_ROOT>\.codex\config.toml
```

不要把这个项目的 MCP 配置写到用户级 Codex 配置，除非你明确要全局安装：

```text
C:\Users\<USER>\.codex\config.toml
```

项目级安装只在当前 workspace 生效，不会污染其他 Codex 会话。

从 `.codex/config.toml.example` 复制模板：

```toml
[mcp_servers.okf-rag]
type = "stdio"
command = ".\\target\\release\\okf-rag.exe"
args = ["mcp", "--root", "."]
```

通用 MCP 配置：

```json
{
  "mcpServers": {
    "okf-rag": {
      "command": "<CLONE_ROOT>\\target\\release\\okf-rag.exe",
      "args": ["mcp", "--root", "<CLONE_ROOT>"]
    }
  }
}
```

工具：

- `okf_rag_status`：查看 workspace、active slot、索引路径、concept 数量、embedding provider。
- `okf_rag_ingest`：把 OKF Markdown 建到 inactive A/B zvec slot，成功后切成 active。
- `okf_rag_query`：在 active 本地索引上执行 full hybrid retrieval。

Agent 使用说明见 [setup-for-agent.md](setup-for-agent.md)。

## 热同步

`okf-rag mcp` 默认启动后台 watcher。它监听 `okf-rag-workspace/okfs`，对文件变化做 debounce，重建 inactive A/B slot，成功后才切 active slot。

```powershell
target\release\okf-rag.exe mcp --root .
target\release\okf-rag.exe mcp --root . --no-watch
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

watcher 会保存 source snapshot，用 `mtime + size` 做 diff，累计 pending changes，debounce 后重建 inactive slot。重建结束后会再 scan 一次，捕捉重建期间发生的新变化。`ingest.lock` 防止多个 MCP 或 CLI 进程同时重建。

## Embedding

运行时 embedding 使用本地 ONNX MiniLM：

```text
sentence-transformers/all-MiniLM-L6-v2
```

模型文件放在：

```text
.okf-rag/models/all-MiniLM-L6-v2/
```

本地模型和 tokenizer 存在时，`ingest`、`query`、`mcp` 不调用远程 embedding API。fallback provider 是确定性的本地 `hash-v1`。

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
cargo clippy -p okf-rag -- -D warnings
cargo build -p okf-rag --release
target\release\okf-rag.exe ingest
target\release\okf-rag.exe query "domain memory zvec" --top-k 5 --candidate-k 50
```

## Ignore 规则

运行期生成文件不进源码管理，但 demo 骨架和 OKF truth 要保留：

```gitignore
/.okf-rag/*
!/.okf-rag/README.md
!/.okf-rag/.gitkeep
/.codex/*
!/.codex/
!/.codex/config.toml.example
!/okf-rag/
!/okf-rag-workspace/
```
