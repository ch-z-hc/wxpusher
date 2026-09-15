// Install the WxPusher "task done" notifier from this folder onto this machine.
//
//   node install.mjs [--host <label>] [--config <file>] [--dry-run]
//
// Copies send-wxpusher-stop.mjs to ~/.codex/, the Pi extension to
// ~/.pi/agent/extensions/ (when Pi is installed), writes ~/.codex/wxpusher.json,
// and registers the Codex Stop hook. Nothing here touches agent model config --
// that is agent-bootstrap's job, not this project's.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1"));
const HOME = os.homedir();
const CODEX_DIR = path.join(HOME, ".codex");
const SCRIPT_NAME = "send-wxpusher-stop.mjs";
const EXT_NAME = "codex-stop-wxpusher.ts";
const script = path.join(CODEX_DIR, SCRIPT_NAME);

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");
const opt = (name) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : "";
};

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function write(p, text, mode) {
  const changed = !fs.existsSync(p) || fs.readFileSync(p, "utf8") !== text;
  actions.push(`${changed ? "*" : "="} ${p}`);
  if (!changed || DRY) return;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  if (mode && os.platform() !== "win32") fs.chmodSync(p, mode);
}

const actions = [];
if (!fs.existsSync(CODEX_DIR)) {
  console.error(`[wxpusher] ${CODEX_DIR} not found -- install Codex first`);
  process.exit(1);
}

const source = opt("--config") || path.join(HERE, "wxpusher.json");
const config = readJson(source, null);
if (!config) {
  console.error(`[wxpusher] ${source} missing or unreadable -- copy wxpusher.example.json to wxpusher.json`);
  process.exit(1);
}
if (!config.spt) {
  console.error("[wxpusher] no spt in the config");
  process.exit(1);
}

const current = readJson(path.join(CODEX_DIR, "wxpusher.json"), {});
const host = opt("--host") || current.host;
const next = { ...config };
delete next.host;
if (host) next.host = host;

write(script, fs.readFileSync(path.join(HERE, SCRIPT_NAME), "utf8"));
if (fs.existsSync(path.join(HOME, ".pi", "agent", "settings.json"))) {
  write(path.join(HOME, ".pi", "agent", "extensions", EXT_NAME),
        fs.readFileSync(path.join(HERE, EXT_NAME), "utf8"));
} else {
  actions.push(`~ ${path.join(HOME, ".pi", "agent", "extensions", EXT_NAME)} (pi not installed, skipped)`);
}
write(path.join(CODEX_DIR, "wxpusher.json"), JSON.stringify(next, null, 2) + "\n", 0o600);

// Codex keys hook trust on hooks.json content, so rewrite only when the command
// is really missing: an unchanged file keeps the saved trust.
const hooksPath = path.join(CODEX_DIR, "hooks.json");
const command = `node "${script}"`;
const hooks = readJson(hooksPath, {});
const stopGroups = ((hooks.hooks || {}).Stop) || [];
const registered = stopGroups.some((group) => (group.hooks || []).some((h) => h.command === command));
if (registered) {
  actions.push(`= ${hooksPath} (Stop hook already registered)`);
} else {
  actions.push(`* ${hooksPath} (register Stop hook)`);
  if (!DRY) {
    hooks.hooks = hooks.hooks || {};
    hooks.hooks.Stop = [...stopGroups, { hooks: [{ type: "command", command }] }];
    fs.writeFileSync(hooksPath, JSON.stringify(hooks, null, 2) + "\n");
    if (os.platform() !== "win32") fs.chmodSync(hooksPath, 0o600);
    console.log("[wxpusher] codex must trust this hook once: an interactive run prompts you,");
    console.log("[wxpusher] or pass --dangerously-bypass-hook-trust to codex exec.");
  }
}

console.log(`${DRY ? "[wxpusher] DRY-RUN -- nothing written" : "[wxpusher] done:"}`);
for (const line of actions) console.log(`  ${line}`);
if (!host && !DRY) console.log(`[wxpusher] set "host" in ${path.join(CODEX_DIR, "wxpusher.json")} to label this machine in pushes`);
