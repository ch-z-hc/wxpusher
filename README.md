# wxpusher-notifier

任务完成时往微信推一条消息（WxPusher）。Codex 走 `Stop` hook，Pi 走一个扩展，两边跑同一个脚本。

[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

只管通知，不碰模型和 API 配置 —— 那是 [ch-z-hc/agent-bootstrap](https://github.com/ch-z-hc/agent-bootstrap) 的事。

## 消息长这样

```text
[laptop · Codex]
把 wxpusher 拆成独立项目，补齐 recap 的路由策略
任务已完成
时间：2026-09-16 13:45:15
```

第一行是**哪台电脑 · 哪个 agent**，第二行是**现写的 recap**：把这次的用户请求和最后一条回复交给 **agent 当前正在用的模型**总结成一句话。

## 技术栈

| 项 | 说明 |
| --- | --- |
| 语言 | Node 18+（用到全局 `fetch`），ESM，**零依赖** |
| 代理路由 | 需要 Node 24+（`NODE_USE_ENV_PROXY`）；老 Node 请用配置项 `node` 指一份 24 |
| 被 hook 的对象 | Codex CLI（`~/.codex/hooks.json` 的 `Stop`）、Pi coding agent（`~/.pi/agent/extensions/`） |
| 推送接口 | `POST https://wxpusher.zjiecode.com/api/send/message/simple-push` |
| 摘要接口 | `POST <base_url>/chat/completions`（OpenAI 兼容） |

## 架构

```
agent 回合结束
  ├─ Codex Stop hook ──► node send-wxpusher-stop.mjs ──┐
  └─ Pi agent_settled ──► 同上，附 --agent Pi + live model 信息
                                                     │
                        父进程：存 payload → 派生 detached 子进程 → 立刻退出
                                                     │  （agent 一秒都不等）
                        子进程：resolveCandidates() ──┤
                                                     ├─► 生成 recap（模型调用）
                                                     └─► simple-push（直连）
```

要点：

- **recap 的模型按偏好顺序取候选**，① agent 上报的当前模型（Pi 直接传 `model` + `base_url` + `api_key`；Codex 从 `~/.codex/config.toml` 解析它自己的 provider 和 key）② Codex 的 provider 端点 ③ `wxpusher.json` 里可选的 `summary` 块。
- **同一个候选内部，直连与走代理竞速**。Node 不吃 Windows 系统代理，而有些上游（例如 b.ai）只有本机 clash/mihomo 能到；竞速保证「当前模型只要有一条路走得通就一定用它」。
- **推送永远直连**。本机代理挂了照样能收到通知，最多退化成「最后一条回复的首行」。
- 调不通就回落，绝不抛错拖住 agent。

## 快速开始

```sh
git clone https://github.com/ch-z-hc/wxpusher.git && cd wxpusher
cp wxpusher.example.json wxpusher.json      # 填 spt / uids
node install.mjs --dry-run                  # 先看要动什么
node install.mjs --host laptop --proxy http://127.0.0.1:7897
```

`install.mjs` 会：把 `send-wxpusher-stop.mjs` 放进 `~/.codex/`、把 `codex-stop-wxpusher.ts` 放进 `~/.pi/agent/extensions/`（装了 Pi 才放）、写 `~/.codex/wxpusher.json`、并在 `~/.codex/hooks.json` 里注册 `Stop` hook。幂等，重复跑只会 `=`。

## 配置项

`~/.codex/wxpusher.json` 是**每台机器自己的**运行时配置，由 `install.mjs` 从仓库的 `wxpusher.json` 生成：

| 字段 | 来源 | 说明 |
| --- | --- | --- |
| `spt` / `uids` | 仓库 `wxpusher.json`（gitignored） | WxPusher 凭据 |
| `host` | `--host`，否则沿用已有 | 推送里显示的机器名。几台机器 hostname 撞车是常事，手机得分得清 |
| `proxy` | `--proxy`，否则沿用已有 | recap 取模型的兜底路由 |
| `node` | `--node`，否则沿用已有 | 需要 Node 24+ 才能走代理；全局 node 版本低时，指一份绝对路径 |
| `summary` | 手工添加 | 兜底端点（`base_url` / `api_key` / `model`），一般不需要 |

## 项目结构

```
wxpusher/
├── send-wxpusher-stop.mjs        # 推送主体：候选解析、双路由竞速、recap 清洗、simple-push
├── codex-stop-wxpusher.ts        # Pi 扩展：记录最后一条 user/assistant，上报 live model
├── install.mjs                   # 部署与 Codex hook 注册（幂等）
├── wxpusher.example.json         # 凭据模板
└── wxpusher.json                 # 本机凭据（gitignored）
```

## 主要功能

- **标明来源**：`[电脑 · Agent]` 进正文第一行，也进微信列表的 `summary`。
- **recap 跟模型**：换模型不用改配置；请求带 `Idempotency-Key`，因为部分网关（aizex）会对内容完全相同的请求回 `409 duplicate_request`。
- **清洗输出**：剥掉混进正文的思考标签（`<th…>`）和 `**`，正文空时改取 `reasoning_content`。
- **不破坏 hook 信任**：Codex 按 `hooks.json` 的内容记可信状态，所以只在命令真的缺失时才重写它；更新脚本内容不会碰到它。
- 环境变量开关：`WXPUSHER_SYNC=1` 前台跑（便于调试），`CODEX_STOP_WXPUSHER_DRY_RUN=1` 完全不推。

## 开发流程

1. 只改本仓库的文件，**别直接改部署好的副本**（下次 `install.mjs` 会覆盖）。
2. `node --check send-wxpusher-stop.mjs` → `node install.mjs`（本机幂等重装）→ 见下方「测试」手法验证一条。
3. 提交推远端；其它机器 `cd ~/wxpusher && git pull && node install.mjs`。
4. 三台部署文件应该 md5 一致（仓库统一 LF，`*.mjs`/`*.ts` 别留 CRLF）。

## 编码规范

- 零依赖、单文件、ESM；不用 `import` 外部包，方便扔到任何机器上跑。
- 任何失败路径都必须 `resolve("")` 或静默返回，通知逻辑不许让 agent 报错、卡住或看到堆栈。
- 子进程与父进程之间用 `WXPUSHER_RECAP:` 标记传递 recap，避免把无关输出当成结果。
- 临时 payload 一律落 `os.tmpdir()` 并在 `close` / `finally` 里删除。

## 测试

没有自动化测试，用两条内置手段：

- `node ~/.codex/send-wxpusher-stop.mjs --summarize-only <file>`：只跑一次摘要调用并把 recap 打到 `WXPUSHER_RECAP:` 之后，不推送。
- 想看整条候选链命中了哪个端点：给部署副本打个补丁，把 `response.status` / `served_model` 打到 stderr，并用 `SKIP_PUSH=1` 拦掉推送（**以网关回报的 `served_model` 为准，模型自述身份不可信**）。
- 端到端：`codex exec` / `pi -p` 跑一轮，检查系统临时目录里 `wxpusher-*.json` 有没有被消费掉（有残留 = 后台 worker 没跑成）。
- 已实测矩阵：3 台机器 × {Codex, Pi}，6 种组合的 recap 全部由**当前模型**写出。

## 排错

- **收不到消息**：先确认 Codex 已信任这个 hook —— 第一次会提示，交互跑一次 `codex` 允许即可；非交互可加 `--dangerously-bypass-hook-trust`。Pi 侧改了扩展要重开会话或 `/reload`。
- **recap 总是被截断的首行**：模型端点没调通。看 `~/.codex/config.toml` 里那个端点本机能否直连；不能就配 `proxy`（Node 需 ≥ 24，或用 `node` 指一份 24）。
- **recap 变成思考片段**：已剥标签；若仍出现，调 `SUMMARY_PROMPT`。
- 手测一条（前台、不走 hook）：

  ```sh
  echo '{"model":"qwen3.8-flash","last_assistant_message":"done"}' \
    | WXPUSHER_SYNC=1 node ~/.codex/send-wxpusher-stop.mjs --agent Pi
  ```

## 安全

`wxpusher.json` 里的 **SPT 相当于长期凭据**：拿到它的人能往你的微信推消息。官方文档也明确要求别把它贴进代码、日志、截图或仓库，因此该文件已 gitignore，仓库里只有 `wxpusher.example.json` 占位模板。泄露后请重新订阅换取新 SPT（本项目不含任何真实凭据）。

## Contributing

自用为主。改动请保持零依赖与「绝不阻塞 agent」这两条底线，并在 PR 里说明你在哪台机器、哪个 agent 上验证过。

## License

[MIT](LICENSE)
