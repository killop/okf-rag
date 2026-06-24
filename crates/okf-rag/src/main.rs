use std::collections::{BTreeMap, HashMap, HashSet};
use std::env;
use std::error::Error;
use std::fs::{self, OpenOptions};
use std::hash::{Hash, Hasher};
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use ndarray::Array2;
use ort::{
    inputs,
    session::{builder::GraphOptimizationLevel, Session},
    value::TensorRef,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokenizers::{PaddingParams, PaddingStrategy, Tokenizer, TruncationParams, TruncationStrategy};
use zvec::{
    initialize, shutdown, Collection, CollectionOptions, CollectionSchema, DataType, Doc,
    FieldSchema, IndexParams, MetricType, SearchQuery,
};

const EMBEDDING_DIM: usize = 384;
const DEFAULT_TOP_K: usize = 5;
const DEFAULT_CANDIDATE_K: usize = 100;
const META_DIR: &str = ".okf-rag";
const WORKSPACE_DIR: &str = "okf-rag-workspace";
const DEFAULT_OKF_DIR: &str = "okfs";
const INDEX_DIR: &str = "index/zvec";
const SLOT_A_INDEX_DIR: &str = "index/zvec-a";
const SLOT_B_INDEX_DIR: &str = "index/zvec-b";
const ACTIVE_SLOT_FILE: &str = "active-slot.json";
const MANIFEST_FILE: &str = "manifest.tsv";
const EMBEDDING_FILE: &str = "embedding.json";
const INGEST_STATE_FILE: &str = "ingest-state.json";
const WATCHER_STATE_FILE: &str = "watcher-state.json";
const INGEST_LOCK_FILE: &str = "ingest.lock";
const HASH_PROVIDER: &str = "hash-v1";
const MINILM_PROVIDER: &str = "minilm-l6-v2-onnx";
const MINILM_MODEL_DIR: &str = "models/all-MiniLM-L6-v2";
const MINILM_MAX_LENGTH: usize = 256;
const DEFAULT_ONNX_BATCH_SIZE: usize = 16;
const DEFAULT_ONNX_THREADS: usize = 4;
const WATCH_POLL_INTERVAL: Duration = Duration::from_secs(1);
const WATCH_DEBOUNCE: Duration = Duration::from_secs(2);
const INGEST_LOCK_STALE_AFTER: Duration = Duration::from_secs(300);
const INGEST_LOCK_WAIT_TIMEOUT: Duration = Duration::from_secs(120);
const WORKSPACE_INDEX_TEMPLATE: &str = r#"# OKF-RAG Workspace

This folder is the user workspace for OKF Markdown truth files.

- `okfs/` stores source OKF Markdown files.
- `.okf-rag/` at the workspace root stores derived cache, indexes, reports, and model state.
- The Rust source project is `okf-rag` when this code is published as its own repository.
"#;
const OKF_INDEX_TEMPLATE: &str = r#"# OKF Markdown Index

Source OKF Markdown files in this folder are indexed by default when running:

```powershell
okf-rag ingest
```

Generated or stale retrieval state belongs in `.okf-rag/`, not here.
"#;

type AppResult<T> = Result<T, Box<dyn Error>>;

#[derive(Clone, Debug)]
struct Concept {
    concept_id: String,
    source_path: PathBuf,
    title: String,
    description: String,
    tags: Vec<String>,
    uri: String,
    disclosure: String,
    body: String,
}

#[derive(Clone, Debug, Serialize)]
struct Hit {
    concept_id: String,
    source_path: String,
    title: String,
    description: String,
    uri: String,
    disclosure: String,
    vector_score: f32,
    lexical_score: f32,
}

#[derive(Clone, Debug, Serialize)]
struct IngestSummary {
    concepts: usize,
    index_path: String,
    active_slot: String,
    embedding_provider: String,
    embedding_cache_hits: usize,
    embedding_cache_misses: usize,
    written: u64,
    errors: u64,
    skipped: bool,
}

#[derive(Clone, Debug, Serialize)]
struct StatusSummary {
    root: String,
    meta: String,
    workspace: String,
    default_okf_source: String,
    index: String,
    active_slot: String,
    concepts: usize,
    embedding_provider: String,
    embedding_model: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct EmbeddingMetadata {
    provider: String,
    dim: usize,
    model: String,
}

#[derive(Debug, Deserialize)]
struct RpcRequest {
    id: Option<Value>,
    method: String,
    params: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct EvalSuite {
    queries: Vec<EvalCase>,
}

#[derive(Clone, Debug, Deserialize)]
struct EvalCase {
    id: String,
    query_type: String,
    query: String,
    expected: Vec<String>,
}

#[derive(Debug, Serialize)]
struct BenchSummary {
    query_count: usize,
    top_k: usize,
    candidate_k: usize,
    embedding_provider: String,
    embedding_model: String,
    hit_at_1: f32,
    hit_at_3: f32,
    hit_at_5: f32,
    hit_at_10: f32,
    mrr_at_10: f32,
    latency_ms: LatencySummary,
    embedding_ms: LatencySummary,
    zvec_ms: LatencySummary,
    by_type: BTreeMap<String, BenchTypeSummary>,
    misses: Vec<BenchMiss>,
}

#[derive(Debug, Serialize)]
struct BenchTypeSummary {
    count: usize,
    hit_at_1: f32,
    hit_at_5: f32,
    hit_at_10: f32,
}

#[derive(Debug, Serialize)]
struct LatencySummary {
    total: f64,
    avg: f64,
    p50: f64,
    p95: f64,
    min: f64,
    max: f64,
}

#[derive(Debug, Serialize)]
struct BenchMiss {
    id: String,
    query_type: String,
    expected: Vec<String>,
    top: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct CachedEmbedding {
    provider: String,
    dim: usize,
    text_hash: String,
    vector: Vec<f32>,
}

struct CachedEmbeddings {
    vectors: Vec<Vec<f32>>,
    hits: usize,
    misses: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct IngestState {
    source_fingerprint: String,
    embedding: EmbeddingMetadata,
    concepts: usize,
    #[serde(default)]
    source_snapshot: Option<BTreeMap<String, FileStamp>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct ActiveSlotState {
    active: String,
    updated_unix_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct FileStamp {
    mtime_ns: u64,
    size: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Change {
    path: String,
    kind: String,
}

#[derive(Clone, Debug, Serialize)]
struct WatcherState {
    pid: u32,
    source: String,
    poll_ms: u64,
    debounce_ms: u64,
    tracked_files: usize,
    pending_count: usize,
    pending: Vec<Change>,
    active_slot: String,
    last_change_unix_ms: Option<u64>,
    last_refresh_unix_ms: Option<u64>,
    last_refresh_status: String,
    last_error: Option<String>,
}

struct WatcherRuntimeStatus<'a> {
    last_change_unix_ms: Option<u64>,
    last_refresh_unix_ms: Option<u64>,
    last_refresh_status: &'a str,
    last_error: Option<&'a str>,
}

fn main() {
    if let Err(err) = run() {
        eprintln!("error: {err}");
        std::process::exit(1);
    }
}

fn run() -> AppResult<()> {
    let mut args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() {
        print_help();
        return Ok(());
    }
    let command = args.remove(0);
    match command.as_str() {
        "init" => command_init(parse_root(&mut args)?)?,
        "ingest" => {
            let root = parse_root(&mut args)?;
            let force = parse_bool_flag(&mut args, "--force");
            let source = args
                .first()
                .map(PathBuf::from)
                .map(|path| resolve_under_root(&root, path))
                .unwrap_or_else(|| default_okf_source_dir(&root));
            command_ingest(root, source, force)?;
        }
        "query" => {
            let root = parse_root(&mut args)?;
            let top_k = parse_usize_flag(&mut args, "--top-k", DEFAULT_TOP_K)?;
            let candidate_k = parse_usize_flag(&mut args, "--candidate-k", DEFAULT_CANDIDATE_K)?;
            if args.is_empty() {
                return Err("query requires text".into());
            }
            command_query(root, args.join(" "), top_k, candidate_k)?;
        }
        "status" => command_status(parse_root(&mut args)?)?,
        "mcp" => {
            let root = parse_root(&mut args)?;
            let watch = !parse_bool_flag(&mut args, "--no-watch");
            command_mcp(root, watch)?;
        }
        "bench" => {
            let root = parse_root(&mut args)?;
            let top_k = parse_usize_flag(&mut args, "--top-k", 10)?;
            let candidate_k = parse_usize_flag(&mut args, "--candidate-k", DEFAULT_CANDIDATE_K)?;
            if args.is_empty() {
                return Err("bench requires an eval json path".into());
            }
            command_bench(root, PathBuf::from(args.remove(0)), top_k, candidate_k)?;
        }
        "help" | "--help" | "-h" => print_help(),
        _ => {
            print_help();
            return Err(format!("unknown command: {command}").into());
        }
    }
    Ok(())
}

fn print_help() {
    println!(
        "okf-rag\n\ncommands:\n  okf-rag init [--root DIR]\n  okf-rag ingest [--root DIR] [--force] [SOURCE_DIR]\n  okf-rag query [--root DIR] [--top-k N] [--candidate-k N] <text>\n  okf-rag bench [--root DIR] [--top-k N] [--candidate-k N] EVAL_JSON\n  okf-rag status [--root DIR]\n  okf-rag mcp [--root DIR] [--no-watch]\n\nwithout SOURCE_DIR, ingest reads okf-rag-workspace/okfs; derived files live under .okf-rag/"
    );
}

fn parse_root(args: &mut Vec<String>) -> AppResult<PathBuf> {
    let mut root = env::current_dir()?;
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--root" {
            if i + 1 >= args.len() {
                return Err("--root requires a directory".into());
            }
            root = PathBuf::from(args.remove(i + 1));
            args.remove(i);
        } else {
            i += 1;
        }
    }
    Ok(root)
}

fn parse_usize_flag(args: &mut Vec<String>, flag: &str, default: usize) -> AppResult<usize> {
    let mut value = default;
    let mut i = 0;
    while i < args.len() {
        if args[i] == flag {
            if i + 1 >= args.len() {
                return Err(format!("{flag} requires a value").into());
            }
            value = args.remove(i + 1).parse::<usize>()?;
            args.remove(i);
        } else {
            i += 1;
        }
    }
    Ok(value)
}

fn parse_bool_flag(args: &mut Vec<String>, flag: &str) -> bool {
    let mut found = false;
    let mut i = 0;
    while i < args.len() {
        if args[i] == flag {
            args.remove(i);
            found = true;
        } else {
            i += 1;
        }
    }
    found
}

fn command_init(root: PathBuf) -> AppResult<()> {
    let meta = init_workspace(&root)?;
    println!("initialized {}", meta.display());
    Ok(())
}

fn command_ingest(root: PathBuf, source: PathBuf, force: bool) -> AppResult<()> {
    let summary = ingest_workspace(&root, &source, force)?;
    if summary.skipped {
        println!(
            "index unchanged; skipped ingest for {} concepts at {} (slot={}) with {}",
            summary.concepts, summary.index_path, summary.active_slot, summary.embedding_provider
        );
        return Ok(());
    }
    println!(
        "ingested {} concepts into {} (slot={}) with {} (cache_hits={}, cache_misses={}, written={}, errors={})",
        summary.concepts,
        summary.index_path,
        summary.active_slot,
        summary.embedding_provider,
        summary.embedding_cache_hits,
        summary.embedding_cache_misses,
        summary.written,
        summary.errors
    );
    Ok(())
}

fn command_query(root: PathBuf, text: String, top_k: usize, candidate_k: usize) -> AppResult<()> {
    let hits = query_workspace(&root, &text, top_k, candidate_k)?;
    print_hits(&hits);
    Ok(())
}

fn command_status(root: PathBuf) -> AppResult<()> {
    let summary = status_workspace(&root)?;
    println!("root: {}", summary.root);
    println!("meta: {}", summary.meta);
    println!("workspace: {}", summary.workspace);
    println!("default_okf_source: {}", summary.default_okf_source);
    println!("active_slot: {}", summary.active_slot);
    println!("index: {}", summary.index);
    println!("concepts: {}", summary.concepts);
    println!("embedding_provider: {}", summary.embedding_provider);
    if !summary.embedding_model.is_empty() {
        println!("embedding_model: {}", summary.embedding_model);
    }
    Ok(())
}

fn command_bench(
    root: PathBuf,
    eval_path: PathBuf,
    top_k: usize,
    candidate_k: usize,
) -> AppResult<()> {
    let summary = bench_workspace(&root, &eval_path, top_k, candidate_k)?;
    println!("{}", serde_json::to_string_pretty(&summary)?);
    Ok(())
}

fn init_workspace(root: &Path) -> AppResult<PathBuf> {
    let meta = meta_dir(root);
    let workspace = workspace_dir(root);
    let okf_source = default_okf_source_dir(root);
    fs::create_dir_all(&okf_source)?;
    write_file_if_missing(&workspace.join("index.md"), WORKSPACE_INDEX_TEMPLATE)?;
    write_file_if_missing(&okf_source.join("index.md"), OKF_INDEX_TEMPLATE)?;
    fs::create_dir_all(meta.join("index"))?;
    fs::create_dir_all(meta.join("cache"))?;
    fs::create_dir_all(meta.join("runs"))?;
    fs::create_dir_all(meta.join("reports"))?;
    Ok(meta)
}

fn ingest_workspace(root: &Path, source: &Path, force: bool) -> AppResult<IngestSummary> {
    init_workspace(root)?;
    let _process_lock = acquire_ingest_lock(root)?;
    let _guard = ingest_mutex().lock().map_err(|_| "ingest lock poisoned")?;
    let concepts = load_concepts(root, source)?;

    let embedding_metadata = detect_embedding_metadata(root)?;
    let source_snapshot = build_source_snapshot(root, source)?;
    let source_fingerprint = concepts_fingerprint(&concepts, &embedding_metadata);
    let embedding_texts: Vec<String> = concepts.iter().map(full_embedding_text).collect();
    let active_slot = read_active_slot(root)?;
    let active_index_path = active_index_dir(root)?;
    let active_slot_ready = active_slot.is_some() && active_index_path.exists();
    let state = IngestState {
        source_fingerprint,
        embedding: embedding_metadata.clone(),
        concepts: concepts.len(),
        source_snapshot: Some(source_snapshot),
    };
    if !force
        && active_slot_ready
        && read_ingest_state(root)?
            .as_ref()
            .is_some_and(|previous| ingest_state_matches(previous, &state))
    {
        return Ok(IngestSummary {
            concepts: concepts.len(),
            index_path: path_str(&active_index_path)?.to_string(),
            active_slot: active_slot.unwrap_or_else(|| "legacy".to_string()),
            embedding_provider: embedding_metadata.provider,
            embedding_cache_hits: 0,
            embedding_cache_misses: 0,
            written: 0,
            errors: 0,
            skipped: true,
        });
    }

    let cached_embeddings = embed_with_cache(root, &embedding_metadata, &embedding_texts)?;
    let target_slot = inactive_slot(root)?;
    let index_path = slot_index_dir(root, &target_slot)?;
    if index_path.exists() {
        fs::remove_dir_all(&index_path)?;
    }
    fs::create_dir_all(index_path.parent().unwrap_or_else(|| Path::new(".")))?;

    initialize(None)?;
    let result = (|| -> AppResult<IngestSummary> {
        let schema = create_schema()?;
        let collection = Collection::create_and_open(path_str(&index_path)?, &schema, None)?;
        let mut docs = Vec::with_capacity(concepts.len());
        for (concept, embedding) in concepts.iter().zip(cached_embeddings.vectors.iter()) {
            let mut doc = Doc::new()?;
            doc.set_pk(&stable_pk(&concept.concept_id));
            doc.add_string("concept_id", &concept.concept_id)?;
            doc.add_string("source_path", path_str(&concept.source_path)?)?;
            doc.add_string("title", &concept.title)?;
            doc.add_string("description", &concept.description)?;
            doc.add_string("tags", &concept.tags.join(", "))?;
            doc.add_string("uri", &concept.uri)?;
            doc.add_string("disclosure", &concept.disclosure)?;
            doc.add_string("body", &concept.body)?;
            doc.add_vector_f32("embedding", embedding)?;
            docs.push(doc);
        }
        let refs: Vec<&Doc> = docs.iter().collect();
        let (success_count, error_count) = if refs.is_empty() {
            (0, 0)
        } else {
            let write = collection.upsert(&refs)?;
            (write.success_count, write.error_count)
        };
        collection.flush()?;
        write_manifest(root, &concepts)?;
        write_embedding_metadata(root, &embedding_metadata)?;
        write_ingest_state(root, &state)?;
        write_active_slot(root, &target_slot)?;
        Ok(IngestSummary {
            concepts: concepts.len(),
            index_path: path_str(&index_path)?.to_string(),
            active_slot: target_slot.clone(),
            embedding_provider: embedding_metadata.provider.clone(),
            embedding_cache_hits: cached_embeddings.hits,
            embedding_cache_misses: cached_embeddings.misses,
            written: success_count,
            errors: error_count,
            skipped: false,
        })
    })();
    let _ = shutdown();
    result
}

fn query_workspace(
    root: &Path,
    text: &str,
    top_k: usize,
    candidate_k: usize,
) -> AppResult<Vec<Hit>> {
    let manifest = read_manifest(root)?;
    if manifest.is_empty() {
        return Err("manifest is empty; run okf-rag ingest first".into());
    }
    let limit = candidate_k.max(top_k).min(manifest.len()).max(1);
    let index_path = active_index_dir(root)?;
    if !index_path.exists() {
        return Err("index not found; run okf-rag ingest first".into());
    }

    let metadata = read_embedding_metadata(root)?.unwrap_or_else(default_embedding_metadata);
    let mut embedder = TextEmbedder::from_metadata(root, &metadata)?;
    initialize(None)?;
    let result = (|| -> AppResult<Vec<Hit>> {
        let mut options = CollectionOptions::new()?;
        options.set_read_only(true)?;
        let collection = Collection::open(path_str(&index_path)?, Some(&options))?;
        query_open_collection(&collection, &mut embedder, text, top_k, limit)
    })();
    let _ = shutdown();
    result
}

fn query_open_collection(
    collection: &Collection,
    embedder: &mut TextEmbedder,
    text: &str,
    top_k: usize,
    candidate_k: usize,
) -> AppResult<Vec<Hit>> {
    let vector = embedder.embed(text)?;
    query_open_collection_with_vector(collection, text, top_k, candidate_k, &vector)
}

fn query_open_collection_with_vector(
    collection: &Collection,
    text: &str,
    top_k: usize,
    candidate_k: usize,
    vector: &[f32],
) -> AppResult<Vec<Hit>> {
    let query = SearchQuery::builder()
        .field_name("embedding")
        .vector(vector)
        .topk(candidate_k as i32)
        .output_fields(&[
            "concept_id",
            "source_path",
            "title",
            "description",
            "tags",
            "uri",
            "disclosure",
            "body",
        ])
        .build()?;
    let results = collection.query(&query)?;
    let mut hits = Vec::new();
    for result in results {
        let fields = hit_from_doc(&result, text)?;
        hits.push(fields);
    }
    hits.sort_by(|a, b| {
        b.lexical_score
            .partial_cmp(&a.lexical_score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                b.vector_score
                    .partial_cmp(&a.vector_score)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });
    hits.truncate(top_k);
    Ok(hits)
}

fn bench_workspace(
    root: &Path,
    eval_path: &Path,
    top_k: usize,
    candidate_k: usize,
) -> AppResult<BenchSummary> {
    let suite: EvalSuite = serde_json::from_str(&fs::read_to_string(eval_path)?)?;
    if suite.queries.is_empty() {
        return Err("eval suite has no queries".into());
    }

    let manifest = read_manifest(root)?;
    if manifest.is_empty() {
        return Err("manifest is empty; run okf-rag ingest first".into());
    }
    let index_path = active_index_dir(root)?;
    if !index_path.exists() {
        return Err("index not found; run okf-rag ingest first".into());
    }

    let eval_top_k = top_k.max(10);
    let limit = candidate_k.max(eval_top_k).min(manifest.len()).max(1);
    let metadata = read_embedding_metadata(root)?.unwrap_or_else(default_embedding_metadata);
    let mut embedder = TextEmbedder::from_metadata(root, &metadata)?;

    initialize(None)?;
    let result = (|| -> AppResult<BenchSummary> {
        let mut options = CollectionOptions::new()?;
        options.set_read_only(true)?;
        let collection = Collection::open(path_str(&index_path)?, Some(&options))?;
        let _ = query_open_collection(
            &collection,
            &mut embedder,
            &suite.queries[0].query,
            eval_top_k,
            limit,
        )?;

        let mut total_latencies = Vec::with_capacity(suite.queries.len());
        let mut embedding_latencies = Vec::with_capacity(suite.queries.len());
        let mut zvec_latencies = Vec::with_capacity(suite.queries.len());
        let mut by_type: BTreeMap<String, BenchTypeAccumulator> = BTreeMap::new();
        let mut hit_1 = 0_usize;
        let mut hit_3 = 0_usize;
        let mut hit_5 = 0_usize;
        let mut hit_10 = 0_usize;
        let mut reciprocal_sum = 0.0_f32;
        let mut misses = Vec::new();

        for case in &suite.queries {
            let total_start = Instant::now();
            let embedding_start = Instant::now();
            let vector = embedder.embed(&case.query)?;
            let embedding_ms = embedding_start.elapsed().as_secs_f64() * 1000.0;

            let zvec_start = Instant::now();
            let hits = query_open_collection_with_vector(
                &collection,
                &case.query,
                eval_top_k,
                limit,
                &vector,
            )?;
            let zvec_ms = zvec_start.elapsed().as_secs_f64() * 1000.0;
            let total_ms = total_start.elapsed().as_secs_f64() * 1000.0;

            total_latencies.push(total_ms);
            embedding_latencies.push(embedding_ms);
            zvec_latencies.push(zvec_ms);

            let rank = first_expected_rank(&hits, &case.expected);
            if rank.is_some_and(|value| value <= 1) {
                hit_1 += 1;
            }
            if rank.is_some_and(|value| value <= 3) {
                hit_3 += 1;
            }
            if rank.is_some_and(|value| value <= 5) {
                hit_5 += 1;
            }
            if rank.is_some_and(|value| value <= 10) {
                hit_10 += 1;
            }
            if let Some(rank) = rank.filter(|value| *value <= 10) {
                reciprocal_sum += 1.0 / rank as f32;
            }

            let type_entry = by_type.entry(case.query_type.clone()).or_default();
            type_entry.count += 1;
            type_entry.hit_1 += usize::from(rank.is_some_and(|value| value <= 1));
            type_entry.hit_5 += usize::from(rank.is_some_and(|value| value <= 5));
            type_entry.hit_10 += usize::from(rank.is_some_and(|value| value <= 10));

            if !rank.is_some_and(|value| value <= 10) && misses.len() < 20 {
                misses.push(BenchMiss {
                    id: case.id.clone(),
                    query_type: case.query_type.clone(),
                    expected: case.expected.clone(),
                    top: hits
                        .iter()
                        .take(10)
                        .map(|hit| hit.concept_id.clone())
                        .collect(),
                });
            }
        }

        let query_count = suite.queries.len();
        Ok(BenchSummary {
            query_count,
            top_k: eval_top_k,
            candidate_k: limit,
            embedding_provider: metadata.provider.clone(),
            embedding_model: metadata.model.clone(),
            hit_at_1: ratio(hit_1, query_count),
            hit_at_3: ratio(hit_3, query_count),
            hit_at_5: ratio(hit_5, query_count),
            hit_at_10: ratio(hit_10, query_count),
            mrr_at_10: reciprocal_sum / query_count as f32,
            latency_ms: LatencySummary::from_samples(&total_latencies),
            embedding_ms: LatencySummary::from_samples(&embedding_latencies),
            zvec_ms: LatencySummary::from_samples(&zvec_latencies),
            by_type: by_type
                .into_iter()
                .map(|(query_type, acc)| {
                    (
                        query_type,
                        BenchTypeSummary {
                            count: acc.count,
                            hit_at_1: ratio(acc.hit_1, acc.count),
                            hit_at_5: ratio(acc.hit_5, acc.count),
                            hit_at_10: ratio(acc.hit_10, acc.count),
                        },
                    )
                })
                .collect(),
            misses,
        })
    })();
    let _ = shutdown();
    result
}

#[derive(Default)]
struct BenchTypeAccumulator {
    count: usize,
    hit_1: usize,
    hit_5: usize,
    hit_10: usize,
}

impl LatencySummary {
    fn from_samples(samples: &[f64]) -> Self {
        let mut sorted = samples.to_vec();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let total = sorted.iter().sum::<f64>();
        Self {
            total,
            avg: total / sorted.len() as f64,
            p50: percentile(&sorted, 0.50),
            p95: percentile(&sorted, 0.95),
            min: *sorted.first().unwrap_or(&0.0),
            max: *sorted.last().unwrap_or(&0.0),
        }
    }
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let index = ((sorted.len() - 1) as f64 * p).round() as usize;
    sorted[index.min(sorted.len() - 1)]
}

fn ratio(numerator: usize, denominator: usize) -> f32 {
    if denominator == 0 {
        0.0
    } else {
        numerator as f32 / denominator as f32
    }
}

fn first_expected_rank(hits: &[Hit], expected: &[String]) -> Option<usize> {
    hits.iter()
        .position(|hit| {
            expected
                .iter()
                .any(|expected_id| expected_id == &hit.concept_id)
        })
        .map(|index| index + 1)
}

fn status_workspace(root: &Path) -> AppResult<StatusSummary> {
    let meta = meta_dir(root);
    let manifest = read_manifest(root).unwrap_or_default();
    let embedding = read_embedding_metadata(root)?.unwrap_or_else(default_embedding_metadata);
    let active_slot = read_active_slot(root)?.unwrap_or_else(|| "legacy".to_string());
    let active_index = active_index_dir(root)?;
    Ok(StatusSummary {
        root: path_str(root)?.to_string(),
        meta: path_str(&meta)?.to_string(),
        workspace: path_str(&workspace_dir(root))?.to_string(),
        default_okf_source: path_str(&default_okf_source_dir(root))?.to_string(),
        index: path_str(&active_index)?.to_string(),
        active_slot,
        concepts: manifest.len(),
        embedding_provider: embedding.provider,
        embedding_model: embedding.model,
    })
}

fn print_hits(hits: &[Hit]) {
    for (idx, hit) in hits.iter().enumerate() {
        println!(
            "{}. score={:.4} hybrid={:.4} {} [{}]",
            idx + 1,
            hit.vector_score,
            hit.lexical_score,
            hit.title,
            hit.concept_id
        );
        println!("   path: {}", hit.source_path);
        if !hit.uri.is_empty() {
            println!("   uri: {}", hit.uri);
        }
        if !hit.disclosure.is_empty() {
            println!("   disclosure: {}", hit.disclosure);
        }
        if !hit.description.is_empty() {
            println!("   description: {}", hit.description);
        }
    }
}

fn command_mcp(root: PathBuf, watch: bool) -> AppResult<()> {
    init_workspace(&root)?;
    if watch {
        start_workspace_watcher(root.clone());
    }
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    for line in stdin.lock().lines() {
        let mut line = line?;
        if line.starts_with('\u{feff}') {
            line = line.trim_start_matches('\u{feff}').to_string();
        }
        if line.contains('\0') {
            line.retain(|ch| ch != '\0');
        }
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<RpcRequest>(&line) {
            Ok(request) => handle_rpc_request(&root, request),
            Err(err) => Some(rpc_error(None, -32700, format!("parse error: {err}"))),
        };
        if let Some(response) = response {
            writeln!(stdout, "{}", serde_json::to_string(&response)?)?;
            stdout.flush()?;
        }
    }
    Ok(())
}

fn start_workspace_watcher(root: PathBuf) {
    thread::spawn(move || watch_default_okf_source(root));
}

fn watch_default_okf_source(root: PathBuf) {
    let source = default_okf_source_dir(&root);
    let mut snapshot = match build_source_snapshot(&root, &source) {
        Ok(snapshot) => snapshot,
        Err(err) => {
            eprintln!(
                "okf-rag watcher: failed to build startup snapshot for {}: {err}",
                source.display()
            );
            BTreeMap::new()
        }
    };
    let mut pending_changes = BTreeMap::<String, Change>::new();
    let mut last_change_at = None::<Instant>;
    let mut last_change_unix_ms = None::<u64>;
    let mut last_refresh_unix_ms = None::<u64>;
    let mut last_refresh_status = "idle".to_string();
    let mut last_error = None::<String>;

    match startup_changes(&root, &snapshot) {
        Ok(changes) => {
            if !changes.is_empty() {
                for change in changes {
                    pending_changes.insert(change.path.clone(), change);
                }
                last_change_at = Some(Instant::now());
                last_change_unix_ms = Some(now_unix_ms());
            }
        }
        Err(err) => {
            last_refresh_status = "startup-scan-failed".to_string();
            last_error = Some(err.to_string());
            eprintln!("okf-rag watcher: startup scan failed: {err}");
        }
    }
    write_watcher_state_best_effort(
        &root,
        &source,
        &snapshot,
        &pending_changes,
        &WatcherRuntimeStatus {
            last_change_unix_ms,
            last_refresh_unix_ms,
            last_refresh_status: &last_refresh_status,
            last_error: last_error.as_deref(),
        },
    );

    loop {
        thread::sleep(WATCH_POLL_INTERVAL);
        let current_snapshot = match build_source_snapshot(&root, &source) {
            Ok(snapshot) => snapshot,
            Err(err) => {
                eprintln!(
                    "okf-rag watcher: failed to scan {}: {err}",
                    source.display()
                );
                continue;
            }
        };

        let detected_changes = diff_snapshots(&snapshot, &current_snapshot);
        if !detected_changes.is_empty() {
            snapshot = current_snapshot;
            for change in detected_changes {
                pending_changes.insert(change.path.clone(), change);
            }
            last_change_at = Some(Instant::now());
            last_change_unix_ms = Some(now_unix_ms());
            write_watcher_state_best_effort(
                &root,
                &source,
                &snapshot,
                &pending_changes,
                &WatcherRuntimeStatus {
                    last_change_unix_ms,
                    last_refresh_unix_ms,
                    last_refresh_status: &last_refresh_status,
                    last_error: last_error.as_deref(),
                },
            );
        }

        let Some(change_at) = last_change_at else {
            continue;
        };
        if pending_changes.is_empty() || change_at.elapsed() < WATCH_DEBOUNCE {
            continue;
        }

        let changes_for_run: Vec<Change> = pending_changes.values().cloned().collect();
        pending_changes.clear();
        let refresh_base_snapshot = snapshot.clone();
        last_refresh_status = "running".to_string();
        last_error = None;
        write_watcher_state_best_effort(
            &root,
            &source,
            &snapshot,
            &pending_changes,
            &WatcherRuntimeStatus {
                last_change_unix_ms,
                last_refresh_unix_ms,
                last_refresh_status: &last_refresh_status,
                last_error: last_error.as_deref(),
            },
        );

        match ingest_workspace(&root, &source, false) {
            Ok(summary) if summary.skipped => {
                last_refresh_status = "skipped".to_string();
                eprintln!("okf-rag watcher: no rebuild needed after pending changes");
            }
            Ok(summary) => {
                last_refresh_status = "ok".to_string();
                eprintln!(
                    "okf-rag watcher: indexed {} concepts into slot {}; changes: {}",
                    summary.concepts,
                    summary.active_slot,
                    change_summary(&changes_for_run)
                );
            }
            Err(err) => {
                last_refresh_status = "failed".to_string();
                last_error = Some(err.to_string());
                eprintln!("okf-rag watcher: ingest failed: {err}");
            }
        }

        last_refresh_unix_ms = Some(now_unix_ms());
        match build_source_snapshot(&root, &source) {
            Ok(after_snapshot) => {
                let follow_up_changes = diff_snapshots(&refresh_base_snapshot, &after_snapshot);
                snapshot = after_snapshot;
                if !follow_up_changes.is_empty() {
                    for change in follow_up_changes {
                        pending_changes.insert(change.path.clone(), change);
                    }
                    last_change_at = Some(Instant::now());
                    last_change_unix_ms = Some(now_unix_ms());
                } else {
                    last_change_at = None;
                }
            }
            Err(err) => {
                last_refresh_status = "post-refresh-scan-failed".to_string();
                last_error = Some(err.to_string());
                eprintln!("okf-rag watcher: post-refresh scan failed: {err}");
            }
        }

        write_watcher_state_best_effort(
            &root,
            &source,
            &snapshot,
            &pending_changes,
            &WatcherRuntimeStatus {
                last_change_unix_ms,
                last_refresh_unix_ms,
                last_refresh_status: &last_refresh_status,
                last_error: last_error.as_deref(),
            },
        );
    }
}

fn handle_rpc_request(server_root: &Path, request: RpcRequest) -> Option<Value> {
    let id = request.id.clone();
    if id.is_none() && request.method.starts_with("notifications/") {
        return None;
    }

    let result = match request.method.as_str() {
        "initialize" => Ok(json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {
                "tools": {}
            },
            "serverInfo": {
                "name": "okf-rag",
                "version": env!("CARGO_PKG_VERSION")
            }
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(mcp_tools()),
        "tools/call" => handle_tool_call(server_root, request.params.unwrap_or_else(|| json!({}))),
        "notifications/initialized" => return None,
        method => Err(format!("unknown method: {method}").into()),
    };

    Some(match result {
        Ok(value) => rpc_result(id, value),
        Err(err) => rpc_error(id, -32000, err.to_string()),
    })
}

fn handle_tool_call(server_root: &Path, params: Value) -> AppResult<Value> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or("tools/call requires params.name")?;
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));

    match name {
        "okf_rag_status" => {
            let root = root_from_arguments(server_root, &arguments);
            let summary = status_workspace(&root)?;
            Ok(tool_result(json!({ "status": summary })))
        }
        "okf_rag_ingest" => {
            let root = root_from_arguments(server_root, &arguments);
            let source = path_argument(&arguments, "source")
                .map(|path| resolve_under_root(&root, path))
                .unwrap_or_else(|| default_okf_source_dir(&root));
            let force = arguments
                .get("force")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let summary = ingest_workspace(&root, &source, force)?;
            Ok(tool_result(json!({ "ingest": summary })))
        }
        "okf_rag_query" => {
            let root = root_from_arguments(server_root, &arguments);
            let text = string_argument(&arguments, "query")
                .or_else(|| string_argument(&arguments, "text"))
                .ok_or("okf_rag_query requires query or text")?;
            let top_k = usize_argument(&arguments, "top_k").unwrap_or(DEFAULT_TOP_K);
            let candidate_k =
                usize_argument(&arguments, "candidate_k").unwrap_or(DEFAULT_CANDIDATE_K);
            let hits = query_workspace(&root, text, top_k, candidate_k)?;
            Ok(tool_result(json!({
                "query": text,
                "top_k": top_k,
                "candidate_k": candidate_k,
                "hits": hits
            })))
        }
        other => Err(format!("unknown tool: {other}").into()),
    }
}

fn mcp_tools() -> Value {
    json!({
        "tools": [
            {
                "name": "okf_rag_status",
                "description": "Show local .okf-rag status for a workspace.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "root": { "type": "string", "description": "Workspace root. Defaults to the server root." }
                    }
                }
            },
            {
                "name": "okf_rag_ingest",
                "description": "Index OKF markdown into the workspace-local .okf-rag cache.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "root": { "type": "string", "description": "Workspace root. Defaults to the server root." },
                        "source": { "type": "string", "description": "Markdown source directory. Relative paths resolve under root. Defaults to okf-rag-workspace/okfs." },
                        "force": { "type": "boolean", "default": false, "description": "Force rebuilding the derived index even when source content is unchanged." }
                    }
                }
            },
            {
                "name": "okf_rag_query",
                "description": "Run full_hybrid retrieval over the local OKF markdown index.",
                "inputSchema": {
                    "type": "object",
                    "required": ["query"],
                    "properties": {
                        "root": { "type": "string", "description": "Workspace root. Defaults to the server root." },
                        "query": { "type": "string", "description": "Natural language retrieval query." },
                        "top_k": { "type": "integer", "minimum": 1, "default": 5 },
                        "candidate_k": { "type": "integer", "minimum": 1, "default": 100 }
                    }
                }
            }
        ]
    })
}

fn rpc_result(id: Option<Value>, result: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id.unwrap_or(Value::Null),
        "result": result
    })
}

fn rpc_error(id: Option<Value>, code: i64, message: String) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id.unwrap_or(Value::Null),
        "error": {
            "code": code,
            "message": message
        }
    })
}

fn tool_result(value: Value) -> Value {
    let text = serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string());
    json!({
        "content": [
            {
                "type": "text",
                "text": text
            }
        ],
        "structuredContent": value,
        "isError": false
    })
}

fn root_from_arguments(server_root: &Path, arguments: &Value) -> PathBuf {
    path_argument(arguments, "root").unwrap_or_else(|| server_root.to_path_buf())
}

fn resolve_under_root(root: &Path, path: PathBuf) -> PathBuf {
    if path.is_absolute() {
        path
    } else {
        root.join(path)
    }
}

fn path_argument(arguments: &Value, key: &str) -> Option<PathBuf> {
    string_argument(arguments, key).map(PathBuf::from)
}

fn string_argument<'a>(arguments: &'a Value, key: &str) -> Option<&'a str> {
    arguments.get(key).and_then(Value::as_str)
}

fn usize_argument(arguments: &Value, key: &str) -> Option<usize> {
    let value = arguments.get(key)?;
    if let Some(number) = value.as_u64() {
        usize::try_from(number).ok()
    } else {
        value.as_str()?.parse::<usize>().ok()
    }
}

enum TextEmbedder {
    Hash,
    MiniLm(Box<MiniLmOnnxEmbedder>),
}

impl TextEmbedder {
    fn from_metadata(root: &Path, metadata: &EmbeddingMetadata) -> AppResult<Self> {
        match metadata.provider.as_str() {
            MINILM_PROVIDER => Ok(Self::MiniLm(Box::new(MiniLmOnnxEmbedder::new(root)?))),
            HASH_PROVIDER => Ok(Self::Hash),
            other => Err(format!("unknown embedding provider in metadata: {other}").into()),
        }
    }

    fn embed(&mut self, text: &str) -> AppResult<Vec<f32>> {
        match self {
            Self::Hash => Ok(embed_hash_text(text)),
            Self::MiniLm(embedder) => embedder.embed(text),
        }
    }

    fn embed_many(&mut self, texts: &[String]) -> AppResult<Vec<Vec<f32>>> {
        match self {
            Self::Hash => Ok(texts.iter().map(|text| embed_hash_text(text)).collect()),
            Self::MiniLm(embedder) => embedder.embed_many(texts),
        }
    }
}

fn detect_embedding_metadata(root: &Path) -> AppResult<EmbeddingMetadata> {
    if minilm_model_path(root).exists() && minilm_tokenizer_path(root).exists() {
        minilm_embedding_metadata(root)
    } else {
        Ok(default_embedding_metadata())
    }
}

fn minilm_embedding_metadata(root: &Path) -> AppResult<EmbeddingMetadata> {
    Ok(EmbeddingMetadata {
        provider: MINILM_PROVIDER.to_string(),
        dim: EMBEDDING_DIM,
        model: path_str(&minilm_model_dir(root))?.to_string(),
    })
}

struct MiniLmOnnxEmbedder {
    tokenizer: Tokenizer,
    session: Session,
    output_name: String,
    max_length: usize,
}

impl MiniLmOnnxEmbedder {
    fn new(root: &Path) -> AppResult<Self> {
        let model_path = minilm_model_path(root);
        let tokenizer_path = minilm_tokenizer_path(root);
        if !model_path.exists() {
            return Err(format!("MiniLM ONNX model not found: {}", model_path.display()).into());
        }
        if !tokenizer_path.exists() {
            return Err(format!("MiniLM tokenizer not found: {}", tokenizer_path.display()).into());
        }

        let mut tokenizer = Tokenizer::from_file(&tokenizer_path).map_err(|err| {
            format!(
                "failed to load tokenizer {}: {err}",
                tokenizer_path.display()
            )
        })?;
        tokenizer
            .with_truncation(Some(TruncationParams {
                max_length: MINILM_MAX_LENGTH,
                strategy: TruncationStrategy::LongestFirst,
                ..Default::default()
            }))
            .map_err(|err| format!("failed to configure tokenizer truncation: {err}"))?;
        tokenizer.with_padding(Some(PaddingParams {
            strategy: PaddingStrategy::BatchLongest,
            ..Default::default()
        }));

        let session = Session::builder()?
            .with_optimization_level(GraphOptimizationLevel::Level3)?
            .with_intra_threads(onnx_thread_count())?
            .commit_from_file(&model_path)?;
        let output_name = preferred_output_name(&session)?.to_string();

        Ok(Self {
            tokenizer,
            session,
            output_name,
            max_length: MINILM_MAX_LENGTH,
        })
    }

    fn embed(&mut self, text: &str) -> AppResult<Vec<f32>> {
        self.embed_many(&[text.to_string()])?
            .into_iter()
            .next()
            .ok_or_else(|| "MiniLM returned no embedding".into())
    }

    fn embed_many(&mut self, texts: &[String]) -> AppResult<Vec<Vec<f32>>> {
        let mut all_embeddings = Vec::with_capacity(texts.len());
        for chunk in texts.chunks(onnx_batch_size()) {
            let inputs: Vec<&str> = chunk.iter().map(String::as_str).collect();
            let encodings = self
                .tokenizer
                .encode_batch(inputs, true)
                .map_err(|err| format!("batch tokenization failed: {err}"))?;
            if encodings.is_empty() {
                continue;
            }

            let batch_size = encodings.len();
            let seq_len = encodings[0].get_ids().len();
            if seq_len == 0 || seq_len > self.max_length {
                return Err(format!("unexpected tokenized length: {seq_len}").into());
            }

            let mut input_ids = Vec::with_capacity(batch_size * seq_len);
            let mut attention_mask_values = Vec::with_capacity(batch_size * seq_len);
            let mut token_type_ids = Vec::with_capacity(batch_size * seq_len);
            for encoding in &encodings {
                if encoding.get_ids().len() != seq_len {
                    return Err("tokenizer returned non-rectangular batch".into());
                }
                input_ids.extend(encoding.get_ids().iter().map(|value| *value as i64));
                attention_mask_values.extend(
                    encoding
                        .get_attention_mask()
                        .iter()
                        .map(|value| *value as i64),
                );
                token_type_ids.extend(encoding.get_type_ids().iter().map(|value| *value as i64));
            }

            let input_ids = Array2::from_shape_vec((batch_size, seq_len), input_ids)?;
            let attention_mask =
                Array2::from_shape_vec((batch_size, seq_len), attention_mask_values.clone())?;
            let token_type_ids = Array2::from_shape_vec((batch_size, seq_len), token_type_ids)?;
            let input_ids = TensorRef::from_array_view(&input_ids)?;
            let attention_mask = TensorRef::from_array_view(&attention_mask)?;
            let token_type_ids = TensorRef::from_array_view(&token_type_ids)?;
            let outputs = self.session.run(inputs! {
                "input_ids" => input_ids,
                "attention_mask" => attention_mask,
                "token_type_ids" => token_type_ids,
            })?;

            let output = outputs
                .get(&self.output_name)
                .ok_or_else(|| format!("ONNX output not found: {}", self.output_name))?;
            let (shape, data) = output.try_extract_tensor::<f32>()?;
            let mut vectors = extract_sentence_embeddings(
                shape,
                data,
                &attention_mask_values,
                batch_size,
                seq_len,
            )?;
            for vector in &mut vectors {
                normalize(vector);
                if vector.len() != EMBEDDING_DIM {
                    return Err(format!(
                        "embedding dimension mismatch: expected {}, got {}",
                        EMBEDDING_DIM,
                        vector.len()
                    )
                    .into());
                }
            }
            all_embeddings.extend(vectors);
        }
        Ok(all_embeddings)
    }
}

fn preferred_output_name(session: &Session) -> AppResult<&str> {
    for preferred in [
        "sentence_embedding",
        "last_hidden_state",
        "token_embeddings",
    ] {
        if session
            .outputs()
            .iter()
            .any(|output| output.name() == preferred)
        {
            return Ok(preferred);
        }
    }
    session
        .outputs()
        .first()
        .map(|output| output.name())
        .ok_or_else(|| "ONNX session has no outputs".into())
}

fn extract_sentence_embeddings(
    shape: &[i64],
    data: &[f32],
    attention_mask: &[i64],
    batch_size: usize,
    seq_len: usize,
) -> AppResult<Vec<Vec<f32>>> {
    if data.len() == batch_size * EMBEDDING_DIM {
        return Ok(data
            .chunks(EMBEDDING_DIM)
            .map(|chunk| chunk.to_vec())
            .collect());
    }

    if shape.len() == 2 && shape[1] as usize == EMBEDDING_DIM {
        let output_batch = shape[0] as usize;
        if output_batch != batch_size {
            return Err(format!(
                "embedding batch mismatch: expected {batch_size}, got {output_batch}"
            )
            .into());
        }
        return Ok(data
            .chunks(EMBEDDING_DIM)
            .map(|chunk| chunk.to_vec())
            .collect());
    }

    if shape.len() == 3 {
        let batch = shape[0] as usize;
        let output_seq_len = shape[1] as usize;
        let hidden = shape[2] as usize;
        if batch != batch_size || output_seq_len != seq_len || hidden != EMBEDDING_DIM {
            return Err(format!("unsupported token embedding shape: {shape:?}").into());
        }
        if data.len() < batch_size * seq_len * hidden {
            return Err("token embedding output is shorter than expected".into());
        }
        let mut vectors = Vec::with_capacity(batch_size);
        for batch_idx in 0..batch_size {
            let mut pooled = vec![0.0_f32; hidden];
            let mut token_count = 0.0_f32;
            for token_idx in 0..seq_len {
                let mask_offset = batch_idx * seq_len + token_idx;
                if attention_mask.get(mask_offset).copied().unwrap_or_default() <= 0 {
                    continue;
                }
                token_count += 1.0;
                let offset = (batch_idx * seq_len + token_idx) * hidden;
                for dim in 0..hidden {
                    pooled[dim] += data[offset + dim];
                }
            }
            if token_count <= 0.0 {
                return Err("attention mask has no active tokens".into());
            }
            for value in &mut pooled {
                *value /= token_count;
            }
            vectors.push(pooled);
        }
        return Ok(vectors);
    }

    Err(format!("unsupported ONNX output shape: {shape:?}").into())
}

fn onnx_batch_size() -> usize {
    env::var("OKF_RAG_ONNX_BATCH_SIZE")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_ONNX_BATCH_SIZE)
}

fn onnx_thread_count() -> usize {
    env::var("OKF_RAG_ONNX_THREADS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_ONNX_THREADS)
}

fn embed_with_cache(
    root: &Path,
    metadata: &EmbeddingMetadata,
    texts: &[String],
) -> AppResult<CachedEmbeddings> {
    let cache_dir = embedding_cache_dir(root);
    fs::create_dir_all(&cache_dir)?;

    let mut vectors: Vec<Option<Vec<f32>>> = vec![None; texts.len()];
    let mut missing_indexes = Vec::new();
    let mut missing_texts = Vec::new();
    let mut missing_hashes = Vec::new();
    let mut hits = 0_usize;

    for (index, text) in texts.iter().enumerate() {
        let text_hash = embedding_text_hash(metadata, text);
        let cache_path = cache_dir.join(format!("{text_hash}.json"));
        if let Some(vector) = read_cached_embedding(&cache_path, metadata, &text_hash) {
            vectors[index] = Some(vector);
            hits += 1;
        } else {
            missing_indexes.push(index);
            missing_texts.push(text.clone());
            missing_hashes.push(text_hash);
        }
    }

    if !missing_texts.is_empty() {
        let mut embedder = TextEmbedder::from_metadata(root, metadata)?;
        let embedded = embedder.embed_many(&missing_texts)?;
        if embedded.len() != missing_texts.len() {
            return Err(format!(
                "embedding batch returned {} vectors for {} texts",
                embedded.len(),
                missing_texts.len()
            )
            .into());
        }

        for (offset, vector) in embedded.into_iter().enumerate() {
            let index = missing_indexes[offset];
            let text_hash = &missing_hashes[offset];
            if vector.len() != EMBEDDING_DIM {
                return Err(format!(
                    "embedding dimension mismatch: expected {}, got {}",
                    EMBEDDING_DIM,
                    vector.len()
                )
                .into());
            }
            write_cached_embedding(&cache_dir, metadata, text_hash, &vector)?;
            vectors[index] = Some(vector);
        }
    }

    let misses = missing_texts.len();
    let vectors = vectors
        .into_iter()
        .enumerate()
        .map(|(index, vector)| {
            vector.ok_or_else(|| format!("missing embedding vector at index {index}").into())
        })
        .collect::<AppResult<Vec<_>>>()?;

    Ok(CachedEmbeddings {
        vectors,
        hits,
        misses,
    })
}

fn read_cached_embedding(
    path: &Path,
    metadata: &EmbeddingMetadata,
    text_hash: &str,
) -> Option<Vec<f32>> {
    let payload = fs::read_to_string(path).ok()?;
    let cached: CachedEmbedding = serde_json::from_str(&payload).ok()?;
    if cached.provider != metadata.provider
        || cached.dim != metadata.dim
        || cached.text_hash != text_hash
        || cached.vector.len() != metadata.dim
    {
        return None;
    }
    Some(cached.vector)
}

fn write_cached_embedding(
    cache_dir: &Path,
    metadata: &EmbeddingMetadata,
    text_hash: &str,
    vector: &[f32],
) -> AppResult<()> {
    let cached = CachedEmbedding {
        provider: metadata.provider.clone(),
        dim: metadata.dim,
        text_hash: text_hash.to_string(),
        vector: vector.to_vec(),
    };
    fs::write(
        cache_dir.join(format!("{text_hash}.json")),
        serde_json::to_vec(&cached)?,
    )?;
    Ok(())
}

fn embedding_text_hash(metadata: &EmbeddingMetadata, text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(metadata.provider.as_bytes());
    hasher.update(b"\0");
    hasher.update(metadata.model.as_bytes());
    hasher.update(b"\0");
    hasher.update(text.as_bytes());
    bytes_to_hex(&hasher.finalize())
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

fn default_embedding_metadata() -> EmbeddingMetadata {
    EmbeddingMetadata {
        provider: HASH_PROVIDER.to_string(),
        dim: EMBEDDING_DIM,
        model: String::new(),
    }
}

fn create_schema() -> zvec::Result<CollectionSchema> {
    CollectionSchema::builder("okf_rag")
        .add_field(FieldSchema::new("concept_id", DataType::String, false, 0)?)
        .add_field(FieldSchema::new("source_path", DataType::String, false, 0)?)
        .add_field(FieldSchema::new("title", DataType::String, false, 0)?)
        .add_field(FieldSchema::new("description", DataType::String, false, 0)?)
        .add_field(FieldSchema::new("tags", DataType::String, false, 0)?)
        .add_field(FieldSchema::new("uri", DataType::String, false, 0)?)
        .add_field(FieldSchema::new("disclosure", DataType::String, false, 0)?)
        .add_field(FieldSchema::new("body", DataType::String, false, 0)?)
        .add_vector_field(
            "embedding",
            DataType::VectorFp32,
            EMBEDDING_DIM as u32,
            IndexParams::flat(MetricType::Cosine)?,
        )
        .build()
}

fn load_concepts(root: &Path, source: &Path) -> AppResult<Vec<Concept>> {
    let mut files = Vec::new();
    collect_markdown_files(source, &mut files)?;
    files.sort();
    let mut concepts = Vec::new();
    for file in files {
        if should_skip_path(root, &file) {
            continue;
        }
        let raw = fs::read_to_string(&file)?;
        let parsed = parse_markdown(&raw);
        let rel = file.strip_prefix(source).unwrap_or(&file);
        let concept_id = rel
            .with_extension("")
            .to_string_lossy()
            .replace('\\', "/")
            .trim_start_matches('/')
            .to_string();
        let title = parsed
            .frontmatter
            .get("title")
            .cloned()
            .or_else(|| first_heading(&parsed.body))
            .unwrap_or_else(|| title_from_path(&file));
        concepts.push(Concept {
            concept_id,
            source_path: file,
            title,
            description: parsed
                .frontmatter
                .get("description")
                .cloned()
                .unwrap_or_default(),
            tags: parsed.tags,
            uri: parsed.nocturne.get("uri").cloned().unwrap_or_default(),
            disclosure: parsed
                .nocturne
                .get("disclosure")
                .cloned()
                .unwrap_or_default(),
            body: parsed.body,
        });
    }
    Ok(concepts)
}

fn collect_markdown_files(dir: &Path, out: &mut Vec<PathBuf>) -> AppResult<()> {
    if dir.is_file() {
        if dir.extension().is_some_and(|ext| ext == "md") {
            out.push(dir.to_path_buf());
        }
        return Ok(());
    }
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name == META_DIR || name == "target" || name == ".git" || name == "third_party" {
                continue;
            }
            collect_markdown_files(&path, out)?;
        } else if path.extension().is_some_and(|ext| ext == "md") {
            let name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
            if name != "index.md" && name != "log.md" {
                out.push(path);
            }
        }
    }
    Ok(())
}

fn should_skip_path(root: &Path, path: &Path) -> bool {
    path.starts_with(meta_dir(root))
        || path.components().any(|part| {
            let text = part.as_os_str().to_string_lossy();
            text == ".git" || text == "target" || text == "third_party"
        })
}

struct ParsedMarkdown {
    frontmatter: HashMap<String, String>,
    nocturne: HashMap<String, String>,
    tags: Vec<String>,
    body: String,
}

fn parse_markdown(text: &str) -> ParsedMarkdown {
    let mut frontmatter = HashMap::new();
    let mut nocturne = HashMap::new();
    let mut tags = Vec::new();
    let mut lines = text.lines();
    let mut fm_lines = Vec::new();
    let mut body_lines = Vec::new();
    if lines.next().map(str::trim) == Some("---") {
        let mut in_fm = true;
        for line in lines {
            if in_fm && line.trim() == "---" {
                in_fm = false;
                continue;
            }
            if in_fm {
                fm_lines.push(line.to_string());
            } else {
                body_lines.push(line.to_string());
            }
        }
    } else {
        body_lines = text.lines().map(ToString::to_string).collect();
    }

    let mut section = String::new();
    for line in fm_lines {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed == "tags:" || trimmed == "nocturne:" {
            section = trimmed.trim_end_matches(':').to_string();
            continue;
        }
        if section == "tags" && trimmed.starts_with("- ") {
            tags.push(unquote(trimmed.trim_start_matches("- ").trim()));
            continue;
        }
        if section == "nocturne" && line.starts_with(' ') {
            if let Some((key, value)) = split_yaml_pair(trimmed) {
                nocturne.insert(key, value);
            }
            continue;
        }
        section.clear();
        if let Some((key, value)) = split_yaml_pair(trimmed) {
            if key == "tags" {
                tags.extend(parse_inline_tags(&value));
            } else if key == "disclosure" || key == "uri" {
                nocturne.insert(key.clone(), value.clone());
                frontmatter.insert(key, value);
            } else {
                frontmatter.insert(key, value);
            }
        }
    }

    ParsedMarkdown {
        frontmatter,
        nocturne,
        tags,
        body: body_lines.join("\n").trim().to_string(),
    }
}

fn split_yaml_pair(line: &str) -> Option<(String, String)> {
    let (key, value) = line.split_once(':')?;
    Some((key.trim().to_string(), unquote(value.trim())))
}

fn parse_inline_tags(value: &str) -> Vec<String> {
    let trimmed = value.trim();
    if trimmed.starts_with('[') && trimmed.ends_with(']') {
        trimmed[1..trimmed.len() - 1]
            .split(',')
            .map(|item| unquote(item.trim()))
            .filter(|item| !item.is_empty())
            .collect()
    } else if !trimmed.is_empty() {
        vec![unquote(trimmed)]
    } else {
        Vec::new()
    }
}

fn unquote(value: &str) -> String {
    let mut text = value.trim().to_string();
    if (text.starts_with('"') && text.ends_with('"'))
        || (text.starts_with('\'') && text.ends_with('\''))
    {
        text = text[1..text.len().saturating_sub(1)].to_string();
    }
    text
}

fn first_heading(body: &str) -> Option<String> {
    body.lines().find_map(|line| {
        line.trim()
            .strip_prefix("# ")
            .map(|title| title.trim().to_string())
    })
}

fn title_from_path(path: &Path) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("untitled")
        .replace(['-', '_'], " ")
}

fn stable_pk(text: &str) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut hasher);
    format!("doc_{:016x}", hasher.finish())
}

fn full_embedding_text(concept: &Concept) -> String {
    format!(
        "body:\n{}\n\ncatalog:\ntitle: {}\ndescription: {}\ntags: {}\n\nrecall:\nuri: {}\ndisclosure: {}\nwhen_to_recall: {}",
        concept.body,
        concept.title,
        concept.description,
        concept.tags.join(", "),
        concept.uri,
        concept.disclosure,
        concept.disclosure
    )
}

fn embed_hash_text(text: &str) -> Vec<f32> {
    let mut vector = vec![0.0_f32; EMBEDDING_DIM];
    for (position, token) in tokenize(text).into_iter().enumerate() {
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        token.hash(&mut hasher);
        let hash = hasher.finish();
        let index = (hash as usize) % EMBEDDING_DIM;
        let sign = if (hash >> 63) == 0 { 1.0 } else { -1.0 };
        let weight = 1.0 + (1.0 / ((position + 1) as f32).sqrt());
        vector[index] += sign * weight;
    }
    normalize(&mut vector);
    vector
}

fn tokenize(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            current.push(ch.to_ascii_lowercase());
        } else if !current.is_empty() {
            if current.len() > 1 && !stopwords().contains(current.as_str()) {
                tokens.push(std::mem::take(&mut current));
            } else {
                current.clear();
            }
        }
    }
    if !current.is_empty() && current.len() > 1 && !stopwords().contains(current.as_str()) {
        tokens.push(current);
    }
    tokens
}

fn stopwords() -> &'static HashSet<&'static str> {
    use std::sync::OnceLock;
    static STOPWORDS: OnceLock<HashSet<&'static str>> = OnceLock::new();
    STOPWORDS.get_or_init(|| {
        [
            "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "in", "into",
            "is", "it", "of", "on", "or", "should", "that", "the", "this", "to", "what", "when",
            "where", "which", "who", "why", "with",
        ]
        .into_iter()
        .collect()
    })
}

fn normalize(vector: &mut [f32]) {
    let norm = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
    if norm > 1e-12 {
        for value in vector {
            *value /= norm;
        }
    }
}

fn hit_from_doc(doc: &zvec::Doc, query: &str) -> AppResult<Hit> {
    let title = doc.get_string("title")?.unwrap_or_default();
    let description = doc.get_string("description")?.unwrap_or_default();
    let tags = doc.get_string("tags")?.unwrap_or_default();
    let uri = doc.get_string("uri")?.unwrap_or_default();
    let disclosure = doc.get_string("disclosure")?.unwrap_or_default();
    let body = doc.get_string("body")?.unwrap_or_default();
    let concept_id = doc.get_string("concept_id")?.unwrap_or_default();
    let source_path = doc.get_string("source_path")?.unwrap_or_default();
    let fields = [
        (&title, 2.0_f32),
        (&description, 1.5),
        (&tags, 1.4),
        (&uri, 1.2),
        (&disclosure, 3.0),
        (&body, 1.0),
    ];
    let lexical_score = lexical_score(query, &fields);
    Ok(Hit {
        concept_id,
        source_path,
        title,
        description,
        uri,
        disclosure,
        vector_score: doc.get_score(),
        lexical_score,
    })
}

fn lexical_score(query: &str, fields: &[(&String, f32)]) -> f32 {
    let q: HashSet<String> = tokenize(query).into_iter().collect();
    if q.is_empty() {
        return 0.0;
    }
    let mut score = 0.0;
    for (field, weight) in fields {
        let f: HashSet<String> = tokenize(field).into_iter().collect();
        score += *weight * q.intersection(&f).count() as f32;
    }
    score / q.len() as f32
}

fn write_manifest(root: &Path, concepts: &[Concept]) -> AppResult<()> {
    let mut rows = String::from("concept_id\tsource_path\ttitle\n");
    for concept in concepts {
        rows.push_str(&format!(
            "{}\t{}\t{}\n",
            concept.concept_id,
            path_str(&concept.source_path)?,
            concept.title.replace('\t', " ")
        ));
    }
    fs::write(meta_dir(root).join(MANIFEST_FILE), rows)?;
    Ok(())
}

fn read_manifest(root: &Path) -> AppResult<BTreeMap<String, String>> {
    let path = meta_dir(root).join(MANIFEST_FILE);
    if !path.exists() {
        return Ok(BTreeMap::new());
    }
    let mut map = BTreeMap::new();
    for line in fs::read_to_string(path)?.lines().skip(1) {
        let mut parts = line.split('\t');
        if let (Some(id), Some(source)) = (parts.next(), parts.next()) {
            map.insert(id.to_string(), source.to_string());
        }
    }
    Ok(map)
}

fn write_embedding_metadata(root: &Path, metadata: &EmbeddingMetadata) -> AppResult<()> {
    write_json_atomic(&meta_dir(root).join(EMBEDDING_FILE), metadata)?;
    Ok(())
}

fn read_embedding_metadata(root: &Path) -> AppResult<Option<EmbeddingMetadata>> {
    let path = meta_dir(root).join(EMBEDDING_FILE);
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(serde_json::from_str(&fs::read_to_string(path)?)?))
}

fn write_ingest_state(root: &Path, state: &IngestState) -> AppResult<()> {
    write_json_atomic(&meta_dir(root).join(INGEST_STATE_FILE), state)?;
    Ok(())
}

fn read_ingest_state(root: &Path) -> AppResult<Option<IngestState>> {
    let path = meta_dir(root).join(INGEST_STATE_FILE);
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(serde_json::from_str(&fs::read_to_string(path)?)?))
}

fn ingest_state_matches(previous: &IngestState, current: &IngestState) -> bool {
    previous.source_fingerprint == current.source_fingerprint
        && previous.embedding == current.embedding
        && previous.concepts == current.concepts
}

fn startup_changes(
    root: &Path,
    current_snapshot: &BTreeMap<String, FileStamp>,
) -> AppResult<Vec<Change>> {
    if read_active_slot(root)?.is_none() {
        return Ok(vec![Change {
            path: "<startup>".to_string(),
            kind: "initial-refresh".to_string(),
        }]);
    }
    let Some(previous_state) = read_ingest_state(root)? else {
        return Ok(vec![Change {
            path: "<startup>".to_string(),
            kind: "missing-ingest-state".to_string(),
        }]);
    };
    let Some(previous_snapshot) = previous_state.source_snapshot else {
        return Ok(vec![Change {
            path: "<startup>".to_string(),
            kind: "missing-source-snapshot".to_string(),
        }]);
    };
    Ok(diff_snapshots(&previous_snapshot, current_snapshot))
}

fn build_source_snapshot(root: &Path, source: &Path) -> AppResult<BTreeMap<String, FileStamp>> {
    let mut files = Vec::new();
    collect_markdown_files(source, &mut files)?;
    files.sort();
    let mut snapshot = BTreeMap::new();
    for file in files {
        if should_skip_path(root, &file) {
            continue;
        }
        let metadata = fs::metadata(&file)?;
        if !metadata.is_file() {
            continue;
        }
        snapshot.insert(
            path_str(&file)?.to_string(),
            FileStamp {
                mtime_ns: system_time_ns(metadata.modified()?),
                size: metadata.len(),
            },
        );
    }
    Ok(snapshot)
}

fn diff_snapshots(
    previous: &BTreeMap<String, FileStamp>,
    current: &BTreeMap<String, FileStamp>,
) -> Vec<Change> {
    let mut changes = Vec::new();
    for path in current.keys() {
        if !previous.contains_key(path) {
            changes.push(Change {
                path: path.clone(),
                kind: "created".to_string(),
            });
        }
    }
    for path in previous.keys() {
        if !current.contains_key(path) {
            changes.push(Change {
                path: path.clone(),
                kind: "deleted".to_string(),
            });
        }
    }
    for (path, previous_stamp) in previous {
        if let Some(current_stamp) = current.get(path) {
            if previous_stamp != current_stamp {
                changes.push(Change {
                    path: path.clone(),
                    kind: "modified".to_string(),
                });
            }
        }
    }
    changes.sort_by(|a, b| a.path.cmp(&b.path).then_with(|| a.kind.cmp(&b.kind)));
    changes
}

fn change_summary(changes: &[Change]) -> String {
    let mut rendered = Vec::new();
    for (index, change) in changes.iter().enumerate() {
        if index >= 8 {
            rendered.push("...".to_string());
            break;
        }
        rendered.push(format!("{} [{}]", change.path, change.kind));
    }
    if rendered.is_empty() {
        "no captured paths".to_string()
    } else {
        rendered.join("; ")
    }
}

fn write_watcher_state_best_effort(
    root: &Path,
    source: &Path,
    snapshot: &BTreeMap<String, FileStamp>,
    pending_changes: &BTreeMap<String, Change>,
    runtime: &WatcherRuntimeStatus<'_>,
) {
    let active_slot = read_active_slot(root)
        .ok()
        .flatten()
        .unwrap_or_else(|| "legacy".to_string());
    let state = WatcherState {
        pid: std::process::id(),
        source: source.display().to_string(),
        poll_ms: WATCH_POLL_INTERVAL
            .as_millis()
            .try_into()
            .unwrap_or(u64::MAX),
        debounce_ms: WATCH_DEBOUNCE.as_millis().try_into().unwrap_or(u64::MAX),
        tracked_files: snapshot.len(),
        pending_count: pending_changes.len(),
        pending: pending_changes.values().cloned().collect(),
        active_slot,
        last_change_unix_ms: runtime.last_change_unix_ms,
        last_refresh_unix_ms: runtime.last_refresh_unix_ms,
        last_refresh_status: runtime.last_refresh_status.to_string(),
        last_error: runtime.last_error.map(ToString::to_string),
    };
    if let Err(err) = write_json_atomic(&meta_dir(root).join(WATCHER_STATE_FILE), &state) {
        eprintln!("okf-rag watcher: failed to write watcher state: {err}");
    }
}

fn write_active_slot(root: &Path, slot: &str) -> AppResult<()> {
    if !is_valid_slot(slot) {
        return Err(format!("invalid active slot: {slot}").into());
    }
    let state = ActiveSlotState {
        active: slot.to_string(),
        updated_unix_ms: now_unix_ms(),
    };
    write_json_atomic(&active_slot_path(root), &state)?;
    Ok(())
}

fn read_active_slot(root: &Path) -> AppResult<Option<String>> {
    let path = active_slot_path(root);
    if !path.exists() {
        return Ok(None);
    }
    let state: ActiveSlotState = serde_json::from_str(&fs::read_to_string(path)?)?;
    if is_valid_slot(&state.active) {
        Ok(Some(state.active))
    } else {
        Err(format!("invalid active slot in state: {}", state.active).into())
    }
}

fn inactive_slot(root: &Path) -> AppResult<String> {
    Ok(match read_active_slot(root)?.as_deref() {
        Some("a") => "b".to_string(),
        Some("b") => "a".to_string(),
        _ => "a".to_string(),
    })
}

fn active_index_dir(root: &Path) -> AppResult<PathBuf> {
    if let Some(slot) = read_active_slot(root)? {
        slot_index_dir(root, &slot)
    } else {
        Ok(index_dir(root))
    }
}

fn slot_index_dir(root: &Path, slot: &str) -> AppResult<PathBuf> {
    match slot {
        "a" => Ok(meta_dir(root).join(SLOT_A_INDEX_DIR)),
        "b" => Ok(meta_dir(root).join(SLOT_B_INDEX_DIR)),
        _ => Err(format!("invalid zvec slot: {slot}").into()),
    }
}

fn active_slot_path(root: &Path) -> PathBuf {
    meta_dir(root).join(ACTIVE_SLOT_FILE)
}

fn is_valid_slot(slot: &str) -> bool {
    slot == "a" || slot == "b"
}

fn ingest_mutex() -> &'static Mutex<()> {
    static INGEST_MUTEX: OnceLock<Mutex<()>> = OnceLock::new();
    INGEST_MUTEX.get_or_init(|| Mutex::new(()))
}

struct IngestProcessLock {
    path: PathBuf,
}

impl Drop for IngestProcessLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn acquire_ingest_lock(root: &Path) -> AppResult<IngestProcessLock> {
    let path = meta_dir(root).join(INGEST_LOCK_FILE);
    let started = Instant::now();
    loop {
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                let payload = json!({
                    "pid": std::process::id(),
                    "created_unix_ms": now_unix_ms()
                });
                file.write_all(serde_json::to_string_pretty(&payload)?.as_bytes())?;
                return Ok(IngestProcessLock { path });
            }
            Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {
                if ingest_lock_is_stale(&path) {
                    let _ = fs::remove_file(&path);
                    continue;
                }
                if started.elapsed() >= INGEST_LOCK_WAIT_TIMEOUT {
                    return Err(
                        format!("timed out waiting for ingest lock: {}", path.display()).into(),
                    );
                }
                thread::sleep(Duration::from_millis(100));
            }
            Err(err) => return Err(err.into()),
        }
    }
}

fn ingest_lock_is_stale(path: &Path) -> bool {
    fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age >= INGEST_LOCK_STALE_AFTER)
}

fn write_json_atomic<T: Serialize>(path: &Path, payload: &T) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("path has no file name: {}", path.display()))?;
    let temp_path = path.with_file_name(format!(
        "{file_name}.{}.{}.tmp",
        std::process::id(),
        now_unix_ms()
    ));
    fs::write(&temp_path, serde_json::to_vec_pretty(payload)?)?;
    match fs::rename(&temp_path, path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {
            fs::remove_file(path)?;
            fs::rename(&temp_path, path)?;
            Ok(())
        }
        Err(err) => {
            let _ = fs::remove_file(&temp_path);
            Err(err.into())
        }
    }
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn system_time_ns(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn concepts_fingerprint(concepts: &[Concept], metadata: &EmbeddingMetadata) -> String {
    let mut hasher = Sha256::new();
    hasher.update(metadata.provider.as_bytes());
    hasher.update([0]);
    hasher.update(metadata.model.as_bytes());
    hasher.update([0]);
    hasher.update(metadata.dim.to_le_bytes());
    hasher.update([0]);
    for concept in concepts {
        hash_text_part(&mut hasher, &concept.concept_id);
        hash_text_part(&mut hasher, &concept.source_path.to_string_lossy());
        hash_text_part(&mut hasher, &concept.title);
        hash_text_part(&mut hasher, &concept.description);
        for tag in &concept.tags {
            hash_text_part(&mut hasher, tag);
        }
        hash_text_part(&mut hasher, &concept.uri);
        hash_text_part(&mut hasher, &concept.disclosure);
        hash_text_part(&mut hasher, &concept.body);
    }
    bytes_to_hex(&hasher.finalize())
}

fn hash_text_part(hasher: &mut Sha256, text: &str) {
    hasher.update(text.len().to_le_bytes());
    hasher.update(text.as_bytes());
    hasher.update([0xff]);
}

fn write_file_if_missing(path: &Path, content: &str) -> AppResult<()> {
    if !path.exists() {
        fs::write(path, content)?;
    }
    Ok(())
}

fn meta_dir(root: &Path) -> PathBuf {
    root.join(META_DIR)
}

fn workspace_dir(root: &Path) -> PathBuf {
    root.join(WORKSPACE_DIR)
}

fn default_okf_source_dir(root: &Path) -> PathBuf {
    workspace_dir(root).join(DEFAULT_OKF_DIR)
}

fn index_dir(root: &Path) -> PathBuf {
    meta_dir(root).join(INDEX_DIR)
}

fn embedding_cache_dir(root: &Path) -> PathBuf {
    meta_dir(root).join("cache").join("embeddings")
}

fn minilm_model_dir(root: &Path) -> PathBuf {
    meta_dir(root).join(MINILM_MODEL_DIR)
}

fn minilm_model_path(root: &Path) -> PathBuf {
    minilm_model_dir(root).join("onnx").join("model.onnx")
}

fn minilm_tokenizer_path(root: &Path) -> PathBuf {
    minilm_model_dir(root).join("tokenizer.json")
}

fn path_str(path: &Path) -> AppResult<&str> {
    path.to_str()
        .ok_or_else(|| format!("path is not valid UTF-8: {}", path.display()).into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_knowledge_catalog_frontmatter() {
        let markdown = r#"---
title: "Retention OKF"
description: "Reduce churn"
tags: [okf, retention]
nocturne:
  uri: okf://customer/retention
  disclosure: "When answering retention questions."
---
# Retention OKF

Reduce logo churn through faster support.
"#;

        let parsed = parse_markdown(markdown);

        assert_eq!(parsed.frontmatter.get("title").unwrap(), "Retention OKF");
        assert_eq!(
            parsed.frontmatter.get("description").unwrap(),
            "Reduce churn"
        );
        assert_eq!(parsed.tags, vec!["okf", "retention"]);
        assert_eq!(
            parsed.nocturne.get("uri").unwrap(),
            "okf://customer/retention"
        );
        assert_eq!(
            parsed.nocturne.get("disclosure").unwrap(),
            "When answering retention questions."
        );
        assert!(parsed.body.contains("Reduce logo churn"));
    }

    #[test]
    fn lexical_score_prefers_disclosure_matches() {
        let query = "retention churn";
        let weak = String::from("retention");
        let strong = String::from("retention churn");
        let weak_score = lexical_score(query, &[(&weak, 1.0)]);
        let strong_score = lexical_score(query, &[(&strong, 3.0)]);

        assert!(strong_score > weak_score);
    }

    #[test]
    fn hashed_embedding_has_expected_shape() {
        let vector = embed_hash_text("customer retention churn okf");
        let norm = vector.iter().map(|value| value * value).sum::<f32>().sqrt();

        assert_eq!(vector.len(), EMBEDDING_DIM);
        assert!((norm - 1.0).abs() < 1e-5);
    }
}
