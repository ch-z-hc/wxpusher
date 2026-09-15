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
  return typeof text === "string" && text.trim()
    ? text.trim().split(/\r?\n/, 1)[0].replace(/^#+\s*/, "").trim().slice(0, 80)
    : "";
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

async function summarize(config, input, agent) {
  const summary = config.summary || {};
  const key = (typeof summary.api_key === "string" && summary.api_key.trim())
    ? summary.api_key.trim()
    : (process.env.BAI_API_KEY || "").trim();
  const base = (summary.base_url || "").trim().replace(/\/$/, "");
  const model = (summary.model || "").trim();
  const answer = typeof input?.last_assistant_message === "string"
    ? input.last_assistant_message.trim().slice(0, MAX_CONTEXT_CHARS) : "";
  // Codex gives transcript_path, the Pi extension passes the user message directly.
  const fromInput = typeof input?.last_user_message === "string" ? input.last_user_message.trim() : "";
  const request = (fromInput || lastUserMessage(input?.transcript_path || input?.transcriptPath))
    .slice(0, MAX_CONTEXT_CHARS);
  if (!base || !key || !model || (!answer && !request)) return "";
  const context = [request && `用户：${request}`, answer && `助手：${answer}`].join("\n");
  try {
    const response = await fetch(base + "/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: SUMMARY_PROMPT }, { role: "user", content: context }],
        max_tokens: 80,
        temperature: 0.2,
        enable_thinking: false,
      }),
      signal: AbortSignal.timeout(SUMMARY_TIMEOUT),
    });
    const result = await response.json();
    const text = result?.choices?.[0]?.message?.content;
    return response.ok ? firstLine(text) : "";
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
  const recap = (await summarize(config, input, agent)) || fallbackRecap(input, agent);
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
