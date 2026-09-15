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
- 第二行：现写的 recap —— 拿这次的用户请求 + 最后一条回复，让 `summary.model` 用一句话总结；调不通就退回「最后一条回复的首行」。
- 摘要请求带 `enable_thinking: false`，实测约 3 秒（否则 12 秒）。
- 两步都在一个后台子进程里跑，agent 不用等；想前台跑就 `WXPUSHER_SYNC=1`，想彻底不推就 `CODEX_STOP_WXPUSHER_DRY_RUN=1`。

## 文件

| 文件 | 作用 |
| --- | --- |
| `send-wxpusher-stop.mjs` | 真正发消息的脚本，装到 `~/.codex/` |
| `codex-stop-wxpusher.ts` | Pi 扩展，装到 `~/.pi/agent/extensions/`（没装 Pi 就跳过） |
| `wxpusher.json` | 本机凭据和 recap 模型（已 gitignore，别提交） |
| `wxpusher.example.json` | 上面那个文件的模板 |
| `install.mjs` | 装 / 更新，幂等 |

## 安装

需要 Node 18+（用到了 `fetch`）。

```sh
cp wxpusher.example.json wxpusher.json   # 填 spt / uids / summary
node install.mjs --dry-run               # 先看要动什么
node install.mjs --host acer             # 装，并给这台机器起个名字
```

`host` 只存在部署出来的 `~/.codex/wxpusher.json` 里：仓库的 `wxpusher.json` 不带 host，`--host` 没给就沿用机器上已有的。几台机器 hostname 撞在一起是常事，手机得分得清。

换电脑时：拷这个目录 → `cp wxpusher.example.json wxpusher.json` 填上凭据 → `node install.mjs --host <名字>`。

## 排错

- **收不到消息**：先确认 Codex 已经信任这个 hook。第一次会提示，交互跑一次 `codex` 允许即可；非交互可以 `codex exec --dangerously-bypass-hook-trust`。Pi 侧改了扩展要重开会话或 `/reload`。
- **改了 `hooks.json`**：Codex 按文件内容记可信状态，重写之后要重新允许一次。所以 `install.mjs` 只在命令真的缺失时才动它，更新脚本内容不会碰到它。
- **recap 不对/太长**：改 `summary.model`，或调 `send-wxpusher-stop.mjs` 里的 `SUMMARY_PROMPT`。
- 手测一条（不走 hook，直接前台推）：

  ```sh
  echo '{"last_assistant_message":"done","transcript_path":""}' | WXPUSHER_SYNC=1 node ~/.codex/send-wxpusher-stop.mjs --agent Pi
  ```
