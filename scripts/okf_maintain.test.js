const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildLinkSuggestions,
  conceptFromFile,
  refreshIndexes,
  refreshLinks,
} = require("./okf_maintain.js");

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

function markdown(title, body) {
  return `---\ntype: Reference\ntitle: ${title}\ndescription: ${title} description for maintenance tests.\n---\n\n${body}\n`;
}

test("manual maintenance keeps semantic links directed and writes relation metadata", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "okf-maintain-relations-"));
  try {
    const okfsDir = path.join(root, "okfs");
    const alphaPath = path.join(okfsDir, "bundle", "alpha.md");
    const betaPath = path.join(okfsDir, "bundle", "beta.md");
    write(alphaPath, markdown("Alpha", "Alpha uses [Beta](beta.md)."));
    write(betaPath, markdown("Beta", "Beta is independently documented."));
    const concepts = [
      conceptFromFile(okfsDir, alphaPath),
      conceptFromFile(okfsDir, betaPath),
    ];
    const suggestions = buildLinkSuggestions(concepts, 4, 6);

    assert.equal(suggestions["bundle/alpha.md"].length, 1);
    assert.equal(suggestions["bundle/alpha.md"][0].predicate, "uses");
    assert.equal(suggestions["bundle/beta.md"], undefined);

    refreshLinks(concepts, suggestions);
    const alpha = fs.readFileSync(alphaPath, "utf8");
    const beta = fs.readFileSync(betaPath, "utf8");
    assert.match(alpha, /outbound_relations: \["uses\|bundle\/beta"\]/);
    assert.match(alpha, /inbound_relations: \[\]/);
    assert.match(alpha, /\[\[beta\|Beta\]\] - uses/);
    assert.match(beta, /outbound_relations: \[\]/);
    assert.match(beta, /inbound_relations: \["uses\|bundle\/alpha"\]/);
    assert.match(beta, /\[\[alpha\|Alpha\]\] - incoming: uses/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("manual index refresh versions bundle roots and keeps catalog root unversioned", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "okf-maintain-index-"));
  try {
    const okfsDir = path.join(root, "okfs");
    write(path.join(okfsDir, "bundle", "alpha.md"), markdown("Alpha", "Alpha body."));
    refreshIndexes(okfsDir, true);

    assert.match(
      fs.readFileSync(path.join(okfsDir, "bundle", "index.md"), "utf8"),
      /^---\r?\nokf_version: "0\.1"\r?\n---/
    );
    assert.doesNotMatch(
      fs.readFileSync(path.join(okfsDir, "index.md"), "utf8"),
      /^---/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
