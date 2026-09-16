# wxpusher-notifier

任务完成时往微信推一条消息（WxPusher）。Codex 用 `Stop` hook，Pi 用一个扩展，两边跑同一个脚本。

只管通知，不碰模型和 API 配置 —— 那是 [agent-bootstrap](../agent-bootstrap/) 的事。

## 消息长这样

```text
[acer · Codex]
给 rollcall 登录态加了自动续期，没动 UI
任务已完成
时间：2026-09-16 01:12:03
```

- 第一行：哪台电脑（`host`）· 哪个 agent。
- 第二行：现写的 recap —— 拿这次的用户请求 + 最后一条回复，用**当前这个模型**写一句话总结（Codex 从 `~/.codex/config.toml` 里拿到自己用的端点和 key，Pi 把 live model 直接传过来）；都调不通就退回「最后一条回复的首行」。
- 所以换模型不用改这里：agent 用什么，recap 就用什么。只有当两个 agent 的端点在这台机器上都不可达时，才需要在 `~/.codex/wxpusher.json` 里手动加一个 `summary`（`base_url` / `api_key` / `model`）当兜底。
- 有些端点得走本机代理才通（比如这台笔记本到 b.ai，Python 会自动吃 Windows 系统代理，Node 不会）。那就给 `wxpusher.json` 加一个 `proxy`：`node install.mjs --proxy http://127.0.0.1:7897`。 recap 优先走这个代理（在子进程里，只影响摘要），代理挂了会退回直连再试一遍；**推送本身永远直连**，不会被代理带倒。
- 摘要请求带 `enable_thinking: false`，实测约 3 秒（否则 12 秒）。
- 两步都在一个后台子进程里跑，agent 不用等；想前台跑就 `WXPUSHER_SYNC=1`，想彻底不推就 `CODEX_STOP_WXPUSHER_DRY_RUN=1`。

## 文件

| 文件 | 作用 |
| --- | --- |
| `send-wxpusher-stop.mjs` | 真正发消息的脚本，装到 `~/.codex/` |
| `codex-stop-wxpusher.ts` | Pi 扩展，装到 `~/.pi/agent/extensions/`（没装 Pi 就跳过） |
| `wxpusher.json` | 本机凭据（`spt` / `uids`，已 gitignore，别提交）；`host` / `proxy` 由 install.mjs 按机器保留 |
| `wxpusher.example.json` | 上面那个文件的模板 |
| `install.mjs` | 装 / 更新，幂等 |

## 安装

需要 Node 18+（用到了 `fetch`；要走代理拿 recap 的话得 Node 24+）。

```sh
git clone https://github.com/ch-z-hc/wxpusher.git && cd wxpusher
cp wxpusher.example.json wxpusher.json   # 填 spt / uids
node install.mjs --dry-run                # 先看要动什么
node install.mjs --host acer --proxy http://127.0.0.1:7897   # 装，给这台机器起名，顺便声明代理
```

`host`（推送里显示哪台电脑）和 `proxy`（取 recap 时走哪个代理）只存在部署出来的 `~/.codex/wxpusher.json` 里：仓库的 `wxpusher.json` 不带这两项，`--host` / `--proxy` 没给就沿用机器上已有的。几台机器 hostname 撞在一起是常事，手机得分得清；而 b.ai 这类端点不是每台都能直连。

以后更新：`git pull && node install.mjs`。

## 排错

- **收不到消息**：先确认 Codex 已经信任这个 hook。第一次会提示，交互跑一次 `codex` 允许即可；非交互可以 `codex exec --dangerously-bypass-hook-trust`。Pi 侧改了扩展要重开会话或 `/reload`。
- **改了 `hooks.json`**：Codex 按文件内容记可信状态，重写之后要重新允许一次。所以 `install.mjs` 只在命令真的缺失时才动它，更新脚本内容不会碰到它。
- **recap 总是被截断的首行**：说明模型调不通。看 `~/.codex/config.toml` 里 codex 用的端点本机能不能直连；不能就给 `wxpusher.json` 加 `proxy`（`node install.mjs --proxy http://127.0.0.1:7897`）。另外 Node 要 ≥ 24 才认 `NODE_USE_ENV_PROXY`。
- **recap 不对 / 太长**：改 `send-wxpusher-stop.mjs` 里的 `SUMMARY_PROMPT`。`summary` 块只是兜底（候选链最后一位），agent 自己的端点能调通时它不会被用到。
- 手测一条（不走 hook，直接前台推）：

  ```sh
  echo '{"last_assistant_message":"done","transcript_path":""}' | WXPUSHER_SYNC=1 node ~/.codex/send-wxpusher-stop.mjs --agent Pi
  ```
