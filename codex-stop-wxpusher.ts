// WxPusher "task done" push for Pi. Deployed by install.mjs in this folder into
// ~/.pi/agent/extensions/; edit ~/wxpusher/codex-stop-wxpusher.ts instead.
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Shared with the Codex Stop hook; homedir-relative so one file covers
// Windows and Linux.
const STOP_HOOK = path.join(os.homedir(), ".codex", "send-wxpusher-stop.mjs");

function textOf(message: any): string {
  if (typeof message?.content === "string") return message.content.trim();
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

export default function (pi: ExtensionAPI) {
  let lastUser = "";
  let lastAssistant = "";

  pi.on("message_end", (event) => {
    const message = event.message as any;
    if (message?.role === "user") {
      // Tool results and injected follow-ups also arrive as user messages; the
      // recap only wants what the human actually asked for.
      if (!message.isMeta && !message.terminal) lastUser = textOf(message) || lastUser;
    } else if (message?.role === "assistant") {
      const text = textOf(message);
      if (text) lastAssistant = text;
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const payload: Record<string, unknown> = {
      last_user_message: lastUser,
      last_assistant_message: lastAssistant,
    };
    // Recap defaults to the model that just answered, so keep its endpoint and
    // key alongside the id. Only for OpenAI-style APIs: the recap calls
    // /chat/completions, which an Anthropic-style provider does not serve.
    const model = ctx.model as any;
    if (model?.id && typeof model.api === "string" && model.api.startsWith("openai")) {
      payload.model = model.id;
      let auth: any;
      try {
        auth = await ctx.modelRegistry.getProviderAuth(model.provider);
      } catch { /* fall back to the script's own endpoint lookup */ }
      const baseUrl = model.baseUrl || auth?.auth?.baseUrl;
      const apiKey = auth?.auth?.apiKey;
      if (baseUrl) payload.base_url = baseUrl;
      if (apiKey) payload.api_key = apiKey;
    }
    const child = spawn(process.execPath, [STOP_HOOK, "--agent", "Pi"], {
      detached: true,
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    });
    // Fire and forget: a dead notifier must never surface in the session.
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(payload));
    child.unref();
  });
}
