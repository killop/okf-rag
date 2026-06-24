#!/usr/bin/env node
// Packages the Windows runtime so users do not need to compile Rust locally.
const fs = require("fs");
const path = require("path");

const REQUIRED_RUNTIME_FILES = [
  "okf-rag.exe",
  "onnxruntime.dll",
  "onnxruntime_providers_shared.dll",
  "zvec_c_api.dll",
];

const ROOT_FILES = [
  "README.md",
  "README-CN.md",
  "README-OKF-RAG.md",
  "setup-for-agent.md",
  "OKF-RAG-BENCHMARK.md",
];

const SCRIPT_FILES = [
  "package_okf_rag_release.js",
  "setup_okf_rag_workspace.js",
];

const COPY_DIRS = ["okf-rag", "okf-rag-workspace"];

function parseArgs(argv) {
  const args = {
    root: path.resolve(__dirname, ".."),
    version: timestampVersion(),
    zip: true,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      args.root = path.resolve(requireValue(argv, ++i, "--root"));
    } else if (arg === "--version") {
      args.version = requireValue(argv, ++i, "--version");
    } else if (arg === "--no-zip") {
      args.zip = false;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function requireValue(argv, index, name) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function timestampVersion() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
}

function printHelp() {
  console.log(`Usage: node scripts/package_okf_rag_release.js [--root DIR] [--version VERSION] [--no-zip]

Creates dist/okf-rag-windows-x64-VERSION with the prebuilt Windows runtime,
OKF workspace, docs, and local model files when present.`);
}

function ensureFileExists(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing runtime artifact: ${filePath}. Build release once before packaging.`);
  }
}

function copyFileIfExists(source, destinationDir) {
  if (!fs.existsSync(source)) {
    return;
  }
  fs.mkdirSync(destinationDir, { recursive: true });
  fs.copyFileSync(source, path.join(destinationDir, path.basename(source)));
}

function copyDirIfExists(source, destination) {
  if (!fs.existsSync(source)) {
    return;
  }
  fs.cpSync(source, destination, { recursive: true, force: true });
}

function writeFileIfMissing(filePath, content) {
  if (fs.existsSync(filePath)) {
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function collectFiles(root) {
  const files = [];
  const stack = [root];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  return files.sort((a, b) => a.localeCompare(b));
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let crc = i;
    for (let j = 0; j < 8; j += 1) {
      crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    table[i] = crc >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time:
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2),
    date:
      ((year - 1980) << 9) |
      ((date.getMonth() + 1) << 5) |
      date.getDate(),
  };
}

function makeLocalHeader(entry) {
  const header = Buffer.alloc(30 + entry.name.length);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(entry.time, 10);
  header.writeUInt16LE(entry.date, 12);
  header.writeUInt32LE(entry.crc, 14);
  header.writeUInt32LE(entry.size, 18);
  header.writeUInt32LE(entry.size, 22);
  header.writeUInt16LE(entry.name.length, 26);
  header.writeUInt16LE(0, 28);
  entry.name.copy(header, 30);
  return header;
}

function makeCentralHeader(entry) {
  const header = Buffer.alloc(46 + entry.name.length);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(entry.time, 12);
  header.writeUInt16LE(entry.date, 14);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(entry.size, 20);
  header.writeUInt32LE(entry.size, 24);
  header.writeUInt16LE(entry.name.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(entry.offset, 42);
  entry.name.copy(header, 46);
  return header;
}

function makeEndOfCentralDirectory(entryCount, centralSize, centralOffset) {
  const header = Buffer.alloc(22);
  header.writeUInt32LE(0x06054b50, 0);
  header.writeUInt16LE(0, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(entryCount, 8);
  header.writeUInt16LE(entryCount, 10);
  header.writeUInt32LE(centralSize, 12);
  header.writeUInt32LE(centralOffset, 16);
  header.writeUInt16LE(0, 20);
  return header;
}

function writeStoreZip(zipPath, sourceRoot, zipRootName) {
  const files = collectFiles(sourceRoot);
  const output = fs.openSync(zipPath, "w");
  const central = [];
  let offset = 0;

  try {
    for (const filePath of files) {
      const data = fs.readFileSync(filePath);
      const stat = fs.statSync(filePath);
      if (data.length > 0xffffffff) {
        throw new Error(`File too large for simple ZIP writer: ${filePath}`);
      }

      const relativeName = path
        .join(zipRootName, path.relative(sourceRoot, filePath))
        .replace(/\\/g, "/");
      const { time, date } = dosDateTime(stat.mtime);
      const entry = {
        name: Buffer.from(relativeName, "utf8"),
        time,
        date,
        crc: crc32(data),
        size: data.length,
        offset,
      };

      const localHeader = makeLocalHeader(entry);
      fs.writeSync(output, localHeader);
      fs.writeSync(output, data);
      offset += localHeader.length + data.length;
      central.push(entry);
    }

    const centralOffset = offset;
    let centralSize = 0;
    for (const entry of central) {
      const centralHeader = makeCentralHeader(entry);
      fs.writeSync(output, centralHeader);
      centralSize += centralHeader.length;
    }
    fs.writeSync(output, makeEndOfCentralDirectory(central.length, centralSize, centralOffset));
  } finally {
    fs.closeSync(output);
  }
}

function main() {
  const args = parseArgs(process.argv);
  const rootPath = path.resolve(args.root);
  const releasePath = path.join(rootPath, "target", "release");
  const distPath = path.join(rootPath, "dist");
  const packageName = `okf-rag-windows-x64-${args.version}`;
  const packagePath = path.join(distPath, packageName);
  const runtimePath = path.join(packagePath, "okf-rag-workspace", "bin");

  for (const fileName of REQUIRED_RUNTIME_FILES) {
    ensureFileExists(path.join(releasePath, fileName));
  }

  fs.rmSync(packagePath, { recursive: true, force: true });
  for (const fileName of ROOT_FILES) {
    copyFileIfExists(path.join(rootPath, fileName), packagePath);
  }

  for (const fileName of SCRIPT_FILES) {
    copyFileIfExists(path.join(rootPath, "scripts", fileName), path.join(packagePath, "scripts"));
  }

  for (const dirName of COPY_DIRS) {
    copyDirIfExists(path.join(rootPath, dirName), path.join(packagePath, dirName));
  }

  fs.mkdirSync(runtimePath, { recursive: true });
  for (const fileName of REQUIRED_RUNTIME_FILES) {
    fs.copyFileSync(path.join(releasePath, fileName), path.join(runtimePath, fileName));
  }
  writeFileIfMissing(
    path.join(runtimePath, "README.md"),
    [
      "# OKF-RAG Runtime",
      "",
      "This directory contains the workspace-local executable used by MCP hosts.",
      "Point MCP `command` at `okf-rag-workspace/bin/okf-rag.exe`.",
      "",
    ].join("\n"),
  );

  const metaSource = path.join(rootPath, ".okf-rag");
  const metaDest = path.join(packagePath, ".okf-rag");
  fs.mkdirSync(metaDest, { recursive: true });
  copyFileIfExists(path.join(metaSource, "README.md"), metaDest);
  copyFileIfExists(path.join(metaSource, ".gitkeep"), metaDest);
  copyDirIfExists(path.join(metaSource, "models"), path.join(metaDest, "models"));

  const codexSource = path.join(rootPath, ".codex");
  const codexDest = path.join(packagePath, ".codex");
  copyFileIfExists(path.join(codexSource, "config.toml.example"), codexDest);

  if (args.zip) {
    const zipPath = path.join(distPath, `${packageName}.zip`);
    fs.rmSync(zipPath, { force: true });
    writeStoreZip(zipPath, packagePath, packageName);
    console.log(`zip: ${zipPath}`);
  }

  console.log(`package: ${packagePath}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
