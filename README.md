# wxpusher-notifier

任务完成时往微信推一条消息（WxPusher）。Codex 走 `Stop` hook，Pi 走一个扩展，两边跑同一个脚本。

[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

只管通知：不碰模型、provider 和 API 配置，也不改这两个 agent 的其它设置。

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
| 语言 | Node 18+（用到全局 `fetch`），ESM，**零依赖**、无构建步骤 |
| 代理路由 | 需要 Node 24+（`NODE_USE_ENV_PROXY`）；全局 node 版本低时用配置项 `node` 指一份 24 |
| 被 hook 的对象 | Codex CLI（`~/.codex/hooks.json` 的 `Stop`）、Pi coding agent（`~/.pi/agent/extensions/`） |
| 推送接口 | `POST https://wxpusher.zjiecode.com/api/send/message/simple-push` |
| 摘要接口 | `POST <base_url>/chat/completions`（OpenAI 兼容） |

## 架构

一次推送的完整生命周期：

1. **agent 回合结束** —— Codex 的 `Stop` hook，或 Pi 的 `agent_settled`。两者都执行 `node ~/.codex/send-wxpusher-stop.mjs`，Pi 额外带 `--agent Pi`，并把最后一条 user / assistant 内容和 live model 的 `id` / `base_url` / `api_key` 从 stdin 传进来。
2. **父进程立刻转后台** —— 把 payload 写到临时文件，派生一个 detached 子进程后马上退出（几十毫秒），所以 agent 不等摘要、也不等网络。
3. **子进程排候选** —— 按偏好顺序生成待试的「模型 + 端点 + key」三元组（见下）。
4. **每个候选内部双路由竞速** —— 直连和走本机代理同时发起，谁先返回有效文本用谁；代理那一路跑在子进程里，因为只有 Node 24+ 认 `NODE_USE_ENV_PROXY`。
5. **拿到 recap 就推，拿不到就回落** —— 回落值是最后一条回复的首行。推送本身永远直连，本机代理挂了不影响收到通知。

候选顺序：

| 顺位 | 来源 | 说明 |
| --- | --- | --- |
| ① | agent 上报的当前模型 | Pi 传 `model` + `base_url` + `api_key`；Codex 给 `model`，端点和 key 从 `~/.codex/config.toml` 的 `model_provider` 段解析 |
| ② | Codex 的 provider 端点 | 用于 ① 不通时；若调用方已自带端点，这里改用 codex 配置里的模型，避免拿错模型去问错网关 |
| ③ | `wxpusher.json` 的 `summary` 块 | 手工兜底，前两条都不通才轮到它 |

## 快速开始

```sh
git clone https://github.com/ch-z-hc/wxpusher.git && cd wxpusher
cp wxpusher.example.json wxpusher.json                # 填 spt / uids
node install.mjs --dry-run                            # 先看要动什么
node install.mjs --host laptop --proxy http://127.0.0.1:7897
```

`install.mjs` 会：把 `send-wxpusher-stop.mjs` 放进 `~/.codex/`、把 `codex-stop-wxpusher.ts` 放进 `~/.pi/agent/extensions/`（装了 Pi 才放）、写 `~/.codex/wxpusher.json`、并在 `~/.codex/hooks.json` 里注册 `Stop` hook。幂等，重复跑只会 `=`。

## 配置项

`~/.codex/wxpusher.json` 是**每台机器自己的**运行时配置，由 `install.mjs` 从仓库的 `wxpusher.json` 生成：

| 字段 | 来源 | 说明 |
| --- | --- | --- |
| `spt` / `uids` | 仓库 `wxpusher.json`（gitignored） | WxPusher 凭据 |
| `host` | `--host`，否则沿用已有 | 推送里显示的机器名。几台机器 hostname 撞车是常事，手机得分得清 |
| `proxy` | `--proxy`，否则沿用已有 | recap 取模型的代理路由；没写就只试直连 |
| `node` | `--node`，否则沿用已有 | 走代理需要 Node 24+，可指向一份绝对路径的二进制 |
| `summary` | 手工添加 | 兜底端点（`base_url` / `api_key` / `model`），一般不需要 |

## 项目结构

| 路径 | 作用 |
| --- | --- |
| `send-wxpusher-stop.mjs` | 推送主体：候选解析、双路由竞速、recap 清洗、simple-push |
| `codex-stop-wxpusher.ts` | Pi 扩展：记录最后一条 user / assistant，上报 live model |
| `install.mjs` | 部署与 Codex hook 注册（幂等） |
| `wxpusher.example.json` | 凭据模板 |
| `wxpusher.json` | 本机凭据（gitignored，不入库） |

## 主要功能

- **标明来源**：`[电脑 · Agent]` 进正文第一行，也进微信列表的 `summary`。
- **recap 跟模型走**：换模型不用改配置。请求带 `Idempotency-Key`，因为部分网关会对内容完全相同的请求回 `409 duplicate_request`。
- **清洗输出**：剥掉混进正文的思考标签（`<th…>`）和 `**`，正文空时改取 `reasoning_content`。
- **不破坏 hook 信任**：Codex 按 `hooks.json` 的内容记可信状态，所以 `install.mjs` 只在命令真的缺失时才重写它；更新脚本内容不会碰到它。
- 调试开关：`WXPUSHER_SYNC=1` 前台跑（便于看错误），`CODEX_STOP_WXPUSHER_DRY_RUN=1` 完全不推。

## 开发流程

1. 只改本仓库的文件，**别直接改部署好的副本**（下次 `install.mjs` 会覆盖）。
2. `node --check send-wxpusher-stop.mjs` → `node install.mjs`（本机幂等重装）→ 按「测试」验一条。
3. 提交推远端；其它机器 `git pull && node install.mjs`。
4. 多台机器部署的文件应当 md5 一致：仓库用 `.gitattributes` 把 `*.mjs` / `*.ts` 统一成 LF，别留 CRLF。

## 编码规范

- 零依赖、单文件、ESM：扔到有 Node 的机器上就能跑，不引 `undici`、不装包。
- 任何失败路径都 `resolve("")` 或静默返回；通知逻辑不许让 agent 看到报错、堆栈或额外延迟。
- 父子进程之间用 `WXPUSHER_RECAP:` 标记传递 recap，避免把无关输出当成结果。
- 临时 payload 一律落 `os.tmpdir()`，并在子进程 `close` / `finally` 里删除；残留的 payload 文件正好是「后台 worker 没跑成」的证据。

## 测试

没有自动化测试，用三条内置手段：

- `node ~/.codex/send-wxpusher-stop.mjs --summarize-only <file>`：`file` 里是 `{target, context}`，只跑一次摘要调用，把 recap 打到 `WXPUSHER_RECAP:` 之后，不推送。
- 想看整条候选链命中了哪个端点：给部署副本打个补丁，把 `response.status` / `served_model` 打到 stderr，并用 `SKIP_PUSH=1` 拦掉推送。**以网关回报的 `served_model` 为准**，模型自述身份不可信。
- 端到端：`codex exec` 或 `pi -p` 跑一轮，然后检查临时目录里 `wxpusher-*.json` 有没有被消费掉（有残留 = 后台 worker 没跑成）。
- 已实测矩阵：3 台机器 × {Codex, Pi} 共 6 种组合，recap 全部由当前模型写出。

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

`wxpusher.json` 里的 **SPT 相当于长期凭据**：拿到它的人能往你的微信推消息。官方文档也明确要求别把它贴进代码、日志、截图或仓库，因此该文件已 gitignore，仓库里只有 `wxpusher.example.json` 占位模板。泄露后请重新订阅换取新 SPT。本仓库不含任何真实凭据。

## Contributing

自用为主。改动请守住两条底线：零依赖、绝不阻塞 agent。PR 里说明你在哪台机器、哪个 agent 上验证过。

## License

[MIT](LICENSE)
