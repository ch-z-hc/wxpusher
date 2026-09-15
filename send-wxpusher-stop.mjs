// WxPusher stop notification for Codex (Stop hook) and Pi (agent_settled extension).
// Deployed by install.mjs in this folder; edit ~/wxpusher/send-wxpusher-stop.mjs instead.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const CONFIG = path.join(os.homedir(), ".codex", "wxpusher.json");
const PUSH_URL = "https://wxpusher.zjiecode.com/api/send/message/simple-push";
const MAX_MESSAGE_LENGTH = 2000;
const MAX_SUMMARY_LENGTH = 60;
const MAX_CONTEXT_CHARS = 1500;
const PUSH_TIMEOUT = 15_000;
const SUMMARY_TIMEOUT = 25_000;
const SUMMARY_MARKER = "WXPUSHER_RECAP:";
const TRANSCRIPT_TAIL_BYTES = 262_144;
const SUMMARY_PROMPT =
  "用一句不超过 40 字的中文概括这次任务实际做了什么（做了什么、动了哪里）。只输出这句话本身，不要前缀、引号、结尾句号。";

function argOf(name) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : "";
}

// Which agent is pushing: the Codex Stop hook passes nothing (default), the Pi
// extension passes --agent Pi. WXPUSHER_AGENT works too (ad-hoc shell hooks).
function agentOf() {
  return argOf("--agent") || (process.env.WXPUSHER_AGENT || "").trim() || "Codex";
}

// Which machine: wxpusher.json "host" wins, because several machines can share
// one hostname and the phone has to tell them apart.
function hostOf(config) {
  const value = typeof config.host === "string" ? config.host.trim() : "";
  return value || os.hostname() || "unknown";
}

function readStdin() {
  return new Promise((resolve) => {
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { value += chunk; });
    process.stdin.on("end", () => resolve(value));
  });
}

function firstLine(text) {
  if (typeof text !== "string" || !text.trim()) return "";
  // A thinking block can come back as prose (or as reasoning_content), and it is
  // never the summary. Drop it, then take the first real line.
  const cleaned = text
    .replace(/<thin\w*>[\s\S]*?(?:<\/think\w*>|$)/gi, " ")
    .replace(/\*\*/g, "")
    .trim();
  const line = cleaned
    .split(/\r?\n/)
    .map((s) => s.replace(/^#+\s*/, "").trim())
    .find((s) => s.length > 0) || "";
  return line.slice(0, 80);
}

function fallbackRecap(input, agent) {
  const explicit = [input?.title, input?.task_title, input?.taskTitle]
    .find((v) => typeof v === "string" && v.trim());
  return firstLine(explicit ?? input?.last_assistant_message) || `${agent} 任务`;
}

// Codex gives us transcript_path; the user's own request is the part the final
// answer often leaves out, so pull the last user message out of the rollout.
function lastUserMessage(transcriptPath) {
  if (!transcriptPath) return "";
  let text = "";
  try {
    const fd = fs.openSync(transcriptPath, "r");
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    fs.closeSync(fd);
    for (const line of buffer.toString("utf8").split(/\r?\n/).reverse()) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const payload = entry.payload ?? entry;
      if (payload?.type !== "message" || payload?.role !== "user") continue;
      const userText = (payload.content ?? [])
        .filter((block) => block?.type === "input_text" && typeof block.text === "string")
        .map((block) => block.text)
        .join(" ")
        .trim();
      if (userText) { text = userText; break; }
    }
  } catch {
    return "";
  }
  return text.slice(0, MAX_CONTEXT_CHARS);
}

// Codex keeps its provider endpoint and key in ~/.codex/config.toml, so the
// recap can reuse exactly what the agent just talked to.
function tomlField(block, field) {
  const m = new RegExp("^" + field + "\\s*=\\s*(.*)$", "m").exec(block);
  return m ? m[1].trim() : "";
}

function codexTomlSection(tx, name, suffix) {
  const table = "[model_providers." + name + (suffix || "") + "]";
  const start = tx.indexOf(table);
  if (start === -1) return "";
  const next = tx.indexOf("\n[", start + table.length);
  return next === -1 ? tx.slice(start) : tx.slice(start, next);
}

function codexEndpoint() {
  let tx = "";
  try {
    tx = fs.readFileSync(path.join(os.homedir(), ".codex", "config.toml"), "utf8");
  } catch {
    return null;
  }
  const head = tx.indexOf("\n[") === -1 ? tx : tx.slice(0, tx.indexOf("\n["));
  const model = tomlField(head, "model").replace(/"/g, "");
  const provider = /^model_provider\s*=\s*"([^"]+)"/m.exec(tx);
  if (!provider) return null;
  const block = codexTomlSection(tx, provider[1]);
  const base = tomlField(block, "base_url").replace(/"/g, "");
  let key = "";
  const auth = codexTomlSection(tx, provider[1], ".auth");
  const args = tomlField(auth, "args");
  if (args) {
    try {
      const values = JSON.parse(args);
      if (Array.isArray(values) && values.length) key = String(values[values.length - 1]);
    } catch { /* hand-written config we don't understand */ }
  }
  // scoped to this provider's own table: the retired [model_providers.gpt] block
  // still carries an experimental_bearer_token on these machines
  if (!key) key = tomlField(block, "experimental_bearer_token").replace(/"/g, "");
  return base && key ? { model, base_url: base, api_key: key } : null;
}

// Which model writes the recap: the model the agent is actually using wins, so
// there is one less thing to keep in sync. Order: what the caller told us (Pi
// passes its live model + resolved auth), then Codex's own provider, then an
// explicit `summary` block in wxpusher.json for machines with neither.
function endpointCandidates(config, input) {
  const out = [];
  const seen = new Set();
  const push = (c) => {
    const model = (c.model || "").trim();
    const base = (c.base_url || "").trim().replace(/\/$/, "");
    const key = (c.api_key || "").trim();
    if (!model || !base || !key) return;
    const id = base + "|" + model;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ model, base_url: base, api_key: key });
  };
  push({ model: input?.model, base_url: input?.base_url, api_key: input?.api_key });
  const cx = codexEndpoint();
  if (cx) {
    // When the caller already named its own endpoint (Pi), the Codex fallback has
    // to use Codex's model -- the caller's model usually doesn't exist there.
    const callerHasEndpoint = Boolean((input?.base_url || "").trim() && (input?.api_key || "").trim());
    push({ model: callerHasEndpoint ? cx.model : (input?.model || cx.model),
           base_url: cx.base_url, api_key: cx.api_key });
  }
  const s = config.summary || {};
  push({ model: s.model || cx?.model || input?.model, base_url: s.base_url, api_key: s.api_key });
  return out;
}

async function summarize(config, input) {
  const answer = typeof input?.last_assistant_message === "string"
    ? input.last_assistant_message.trim().slice(0, MAX_CONTEXT_CHARS) : "";
  // Codex gives transcript_path, the Pi extension passes the user message directly.
  const fromInput = typeof input?.last_user_message === "string" ? input.last_user_message.trim() : "";
  const request = (fromInput || lastUserMessage(input?.transcript_path || input?.transcriptPath))
    .slice(0, MAX_CONTEXT_CHARS);
  if (!answer && !request) return "";
  const context = [request && `用户：${request}`, answer && `助手：${answer}`].join("\n");
  const proxy = (config.proxy || "").trim();
  const direct = summarizeEach(endpointCandidates(config, input), context);
  if (!proxy || process.env.WXPUSHER_SUMMARIZE_ONLY) return await direct;
  // Direct and proxied go out at the same time: on this laptop b.ai needs the
  // local proxy and aizex is sometimes slower through it than not, so guessing
  // an order only adds a timeout's worth of waiting. Node ignores the Windows
  // system proxy, hence the proxied copy runs as a child with the env set.
  const racers = [direct, summarizeViaProxy(proxy, input)].map((p) =>
    p.then((text) => (text ? text : Promise.reject(new Error("empty")))));
  try {
    return await Promise.any(racers);
  } catch {
    return "";
  }
}

async function summarizeEach(candidates, context) {
  for (const target of candidates) {
    const text = await summaryCall(target, context);
    if (text) return text;
  }
  return "";
}

// One-shot child that repeats the summary chain with the proxy in its env.
// The recap travels behind a marker so unrelated stdout can't be mistaken for it.
function summarizeViaProxy(proxy, input) {
  return new Promise((resolve) => {
    let tmp = "";
    try {
      tmp = path.join(os.tmpdir(), `wxpusher-sum-${process.pid}-${Date.now()}.json`);
      fs.writeFileSync(tmp, JSON.stringify(input));
      const child = spawn(process.execPath, [process.argv[1], "--summarize-only", tmp], {
        env: { ...process.env, WXPUSHER_SUMMARIZE_ONLY: "1", NODE_USE_ENV_PROXY: "1",
               HTTP_PROXY: proxy, HTTPS_PROXY: proxy },
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      let out = "";
      const kill = setTimeout(() => child.kill(), SUMMARY_TIMEOUT + 5_000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { out += chunk; });
      child.on("error", () => { clearTimeout(kill); resolve(""); });
      child.on("close", () => {
        clearTimeout(kill);
        try { fs.unlinkSync(tmp); } catch { /* already gone */ }
        const i = out.indexOf(SUMMARY_MARKER);
        resolve(i === -1 ? "" : out.slice(i + SUMMARY_MARKER.length).trim().split(/\r?\n/)[0]);
      });
    } catch {
      if (tmp) { try { fs.unlinkSync(tmp); } catch { /* already gone */ } }
      resolve("");
    }
  });
}

async function summaryCall(target, context) {
  try {
    const response = await fetch(target.base_url + "/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${target.api_key}`,
        "Content-Type": "application/json",
        // aizex rejects byte-identical requests with 409 duplicate_request, which
        // two similar turns would hit; the gateway asks for this header explicitly.
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        model: target.model,
        messages: [{ role: "system", content: SUMMARY_PROMPT }, { role: "user", content: context }],
        max_tokens: 80,
        temperature: 0.2,
        enable_thinking: false,
      }),
      signal: AbortSignal.timeout(SUMMARY_TIMEOUT),
    });
    const result = await response.json();
    const msg = result?.choices?.[0]?.message || {};
    // some gateways put the summary in reasoning_content and a block in content
    return response.ok ? (firstLine(msg.content) || firstLine(msg.reasoning_content)) : "";
  } catch {
    return "";
  }
}

function messageOf(recap, host, agent) {
  const time = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(new Date()).replace(/\//g, "-");
  const content = `[${host} · ${agent}]\n${recap}\n任务已完成\n时间：${time}`;
  return {
    content: content.slice(0, MAX_MESSAGE_LENGTH),
    summary: `${host} · ${agent} · ${recap}`.slice(0, MAX_SUMMARY_LENGTH),
  };
}

async function push(input, agent) {
  const config = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
  if (!config.spt) throw new Error("未配置 WxPusher SPT");
  const host = hostOf(config);
  const recap = (await summarize(config, input)) || fallbackRecap(input, agent);
  const { content, summary } = messageOf(recap, host, agent);
  const response = await fetch(PUSH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ spt: config.spt, content, summary, contentType: 1 }),
    signal: AbortSignal.timeout(PUSH_TIMEOUT),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.code !== 1000) throw new Error(result.msg ?? `WxPusher HTTP ${response.status}`);
}

async function main() {
  const agent = agentOf();
  const summarizeOnly = argOf("--summarize-only");
  if (summarizeOnly) {
    // Proxy-retry helper: print the recap on stdout, never push.
    try {
      const input = JSON.parse(fs.readFileSync(summarizeOnly, "utf8"));
      const config = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
      const text = await summarize(config, input);
      if (text) process.stdout.write(SUMMARY_MARKER + text);
    } catch { /* no recap is fine, the fallback still gets pushed */ }
    return;
  }
  const workerFile = argOf("--worker");
  if (workerFile) {
    let payload = {};
    try {
      payload = JSON.parse(fs.readFileSync(workerFile, "utf8"));
      fs.unlinkSync(workerFile);
    } catch { /* a payload we cannot read is not worth failing the turn over */ }
    await push(payload, agent);
    return;
  }

  const inputText = await readStdin();
  const payload = inputText.trim() ? JSON.parse(inputText) : {};
  if (process.env.WXPUSHER_SYNC === "1") {
    await push(payload, agent);
    return;
  }

  // The summary is one model call and the push is one HTTP call: keep the
  // agent turn unblocked by handing them to a detached copy of this script.
  const tmp = path.join(os.tmpdir(), `wxpusher-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(payload));
  const child = spawn(process.execPath, [process.argv[1], "--worker", tmp, "--agent", agent], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.on("error", () => {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
  });
  child.unref();
}

try {
  if (process.env.CODEX_STOP_WXPUSHER_DRY_RUN !== "1") await main();
} catch (error) {
  // Notifications must never block a completed agent turn.
  console.error(`[codex-stop-wxpusher] ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
