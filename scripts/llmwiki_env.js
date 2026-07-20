const fs = require("fs");
const path = require("path");

const PROJECT_ENV_RELATIVE_PATH = path.join(".okf-rag", "llmwiki.env");
const ALLOWED_KEYS = new Set([
  "LLMWIKI_PROVIDER",
  "LLMWIKI_MODEL",
  "LLMWIKI_OUTPUT_LANG",
  "LLMWIKI_COMPILE_CONCURRENCY",
  "LLMWIKI_STREAM_ONLY_OPENAI",
  "LLMWIKI_REPO",
  "LLMWIKI_BIN",
  "LLMWIKI_PACKAGE",
  "LLMWIKI_NODE_PACKAGE",
  "LLMWIKI_RUNTIME_DIR",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "OKF_RAG_BIN",
  "OKF_RAG_MIRROR_WORKSPACE",
]);

function rootFromArgv(argv, cwd = process.cwd()) {
  const index = argv.indexOf("--root");
  if (index < 0 || !argv[index + 1] || argv[index + 1].startsWith("--")) {
    return path.resolve(cwd);
  }
  return path.resolve(cwd, argv[index + 1]);
}

function parseProjectEnv(text, file = PROJECT_ENV_RELATIVE_PATH) {
  const values = {};
  const ignoredKeys = [];
  const lines = String(text).replace(/^\uFEFF/, "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index].trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const separator = line.indexOf("=");
    if (separator < 1) {
      throw new Error(`${file}:${index + 1}: expected KEY=VALUE`);
    }
    const key = line.slice(0, separator).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
      throw new Error(`${file}:${index + 1}: invalid environment key ${key}`);
    }
    if (!ALLOWED_KEYS.has(key)) {
      ignoredKeys.push(key);
      continue;
    }
    values[key] = unquote(line.slice(separator + 1).trim(), file, index + 1);
  }
  return { values, ignoredKeys: [...new Set(ignoredKeys)].sort() };
}

function unquote(value, file, lineNumber) {
  if (!value) return "";
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' || first === "'") && last !== first) {
    throw new Error(`${file}:${lineNumber}: unterminated quoted value`);
  }
  if (first === '"' && last === '"') {
    try {
      return JSON.parse(value);
    } catch {
      throw new Error(`${file}:${lineNumber}: invalid double-quoted value`);
    }
  }
  if (first === "'" && last === "'") return value.slice(1, -1);
  return value;
}

function loadProjectLlmwikiEnv(root, environment = process.env) {
  const resolvedRoot = path.resolve(root || process.cwd());
  const file = path.join(resolvedRoot, PROJECT_ENV_RELATIVE_PATH);
  if (!fs.existsSync(file)) {
    return { file, exists: false, configuredKeys: [], loadedKeys: [], ignoredKeys: [] };
  }
  const parsed = parseProjectEnv(fs.readFileSync(file, "utf8"), file);
  const configuredKeys = Object.entries(parsed.values)
    .filter(([, value]) => value !== "")
    .map(([key]) => key)
    .sort();
  const loadedKeys = [];
  for (const [key, value] of Object.entries(parsed.values)) {
    if (environment[key] !== undefined && environment[key] !== "") continue;
    if (value === "") continue;
    environment[key] = value;
    loadedKeys.push(key);
  }
  return {
    file,
    exists: true,
    configuredKeys,
    loadedKeys: loadedKeys.sort(),
    ignoredKeys: parsed.ignoredKeys,
  };
}

function booleanFromEnv(value, key) {
  if (value === undefined || value === null || String(value).trim() === "") return false;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${key} must be true/false, yes/no, on/off, or 1/0`);
}

module.exports = {
  ALLOWED_KEYS,
  PROJECT_ENV_RELATIVE_PATH,
  booleanFromEnv,
  loadProjectLlmwikiEnv,
  parseProjectEnv,
  rootFromArgv,
};
