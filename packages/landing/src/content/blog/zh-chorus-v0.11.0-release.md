---
title: "Chorus v0.11.0: 派给 Agent 的活，这次它自己接了"
description: "你给 Agent 配好权限、派了任务，然后它在数据库里躺着，等你打开终端把它唤醒。这也叫一直待命的伙伴？"
date: 2026-06-21
lang: zh
postSlug: chorus-v0.11.0-release
---

# Chorus v0.11.0: 派给 Agent 的活，这次它自己接了

你给一个 Agent 配好权限，把一个任务派了过去。按理说它该开始干了，可它没有。任务躺在那儿，要等你哪天打开电脑、跑起 Claude Code、加载好 skill、亲手把它认领下来，那个 Agent 才真正动一下。在那之前，它只是数据库里的一行。

不只是任务。一条想法细化完了，得有人写提案；有人在评论里 @ 了你的 Agent，等它回话。这些都得你坐到终端前，亲手把它唤起，才会发生。Chorus 讲的是 AI 提议、人来验收，可嘴上说 AI 跟人协作，AI 那一半平时压根不在线。它不是个随叫随到的伙伴，是个每次都得你亲手重启的工具。

[Chorus](https://github.com/Chorus-AIDLC/Chorus) v0.11.0 带来了 `chorus daemon`：把你的机器变成一个常驻的 Agent 运行时。服务端把活派过来，daemon 在本地唤起一个 Claude Code 去干。你不用守在终端前，任务过来，本地就把它接住了。

---

## 起一个 daemon，它就一直在那等着

一条命令：

```bash
npx @chorus-aidlc/chorus daemon
```

做的事很简单：用你的 Agent 身份登录，订阅服务端的通知流，然后等。等到一个跟这个 Agent 相关的事件，比如任务派过来、有人 @ 它、细化通过了验收、或者你直接发来一条指令。一旦来了，它就在本地起一个 headless 的 `claude -p`，接上 Chorus 的 MCP，用 `chorus_*` 那套工具去干活。

这里没用 Agent SDK，就是起个子进程。好处是：不带任何新依赖，跨平台；prompt 走 stdin 而不是命令行参数；Windows 上会自己找 `claude.cmd`。装好 Chorus 的 npm 包就能跑。

想让它在后台常驻，加个 `-d`：

```bash
chorus daemon -d        # 后台运行
chorus daemon status    # 看状态
chorus daemon logs      # 看日志
chorus daemon stop      # 停掉
```

第一次跑、没配过凭证、又在终端里，它会直接问你要服务端地址和 API key，验证通过就存到 `~/.chorus/daemon.json`，下次不用再问。不在终端里跑（systemd、nohup、CI），它就直接报错退出，不会卡在一个没人能回答的提示上。

## 同一条想法，是同一场对话

每次唤醒不是各干各的一次性任务。daemon 把每个 session 锚定到对应那条想法的 uuid 上：同一条想法下的活，唤起的是同一个 session，`--resume` 接着上次的上下文往下走；不同想法之间，session 是隔开的。一条没有归属想法的活，比如一个快速任务、一份独立文档，就锚在它自己的 uuid 上，照样有连续的 session。背后一个 WakeQueue 排队，保证同一个 session 不会被两次唤醒同时 `--resume` 撞在一起。

锚在想法 uuid 上还有个好处：你随时能接管。每次唤醒的日志里都带一句提示：

```
[Chorus] spawning new session <idea-uuid> — take over with: claude --resume <idea-uuid>
```

在 daemon 的工作目录里跑这句，你就直接进到 Agent 刚才那场对话里，不用翻 transcript 找会话 ID。这是放手的安全感来源：Agent 干到一半你想接手，随时跳进去，无缝。

## 看得见，还插得进话

Agent 在后台跑，最怕的就是变黑盒：连上了没、这会儿忙啥、干到哪了，你全不知道。

这版在侧边栏加了一个在线 Agent 的小标。点开列出每个在线连接正在跑和排队的活；再点"查看全部"，是一个聊天式的双栏界面：左边是这个 Agent 的所有对话，右边是选中那场的完整 transcript，实时刷新。Agent 说的每句话、跑的每个动作，你都看得到。底下是一份存在数据库里的连接注册表，两个 ECS 实例后面也能看到同一份。

光看不够。Agent 跑偏了，或者你临时想补一句，得插得进去。在那个界面里直接打字，这条指令会作为下一个 turn 跑在这个 session 的源 daemon 上，精确投给当初起它的那台机器，而不是广播给名下所有连接，因为只有那台机器 `--resume` 得回来。正在跑的 turn 也能打断：服务端发一个非唤醒的控制事件，daemon 收到就把那个 headless Claude 的进程树干掉（先 SIGINT 再连子进程一起杀，不带原生依赖）。打断是"粘"的，停在那等你点恢复，再 `--resume` 接着原来那场对话往下续。

也可以干脆不挂任务，直接新开一场对话跟 Agent 聊。这种临时对话和任务执行一样，看得见、打得断、能恢复。

## 默认就是放手让它干

daemon 默认跑在 yolo 模式：被唤起的 Agent 拿到完整的自主权，能跑 Bash、改文件、执行任何命令，用的是这个 daemon 的 API key。这是故意的，它存在的意义就是替你干真正写代码的活，缩手缩脚没意义。所以这版去掉了之前那个一次性的 y/N 确认，改成每次启动都在 banner 里醒目地警告你它在 yolo。想收回权限，加 `--chorus-only`，Agent 就只剩 Chorus 的 MCP 工具，碰不了 shell 和文件。把"放手"明明白白摆在你眼前，而不是塞进一个点一次就忘的确认框里。前提还是那句，只在你信任的、隔离的环境里跑。

---

## 一次没碰终端的闭环

把这些拼起来，Chorus 那句"AI 提议、人来验收"第一次能不碰终端跑完一整圈。

拿细化这一步说。以前一条想法细化完，得靠 Agent 自己调 MCP 工具去验收、推进到写提案。现在想法详情页上多了个"完成细化"的按钮，人点一下就把这条想法的细化定了，同时唤起被派到这条想法上的 Agent，让它去写提案，不是回头再答一轮问题，是直接动手写。

人点一下验收，AI 就接着抛出下一轮。这一来一回，你没开过终端。这才是"反转对话"本来该有的样子：不是人给 prompt、AI 执行，是 AI 提议、人确认、AI 再往前一步。

## 顺着行业在走的路

让 Agent 脱离终端、在无人值守的情况下跑，是这一年整个行业都在走的方向。Claude Code 的 headless `-p` 模式、Agent SDK、各种 background agent，Anthropic 一直在推一件事：Agent 不该需要人守在终端前。Chorus 做的不是发明一套新工作流，是让你已经在用的这套（想法、提案、任务、验收）里，那个被派了活的 Agent 真的常驻、真的开始动。

OpenClaw 插件这版也跟着拉齐了：它实现了和 `chorus` CLI 一模一样的双向 daemon 协议，只是换成它自己 in-process 的 `runEmbeddedAgent`。同一套反向控制通道、执行状态上报、transcript 流式回传，跑到一半也能真打断。服务端一个字没改，两种运行时接的是同一套接口。

回到开头那个问题。派给 Agent 的活，它现在自己接了。那半个平时不在线的 AI，终于一直在线了，不用你再守在终端前，把它从数据库的一行里手动唤醒。

---

## 顺带修了几件事

**Dashboard 的想法面板在软导航时不同步。** 从通知、SSE 弹窗、全局搜索点一条想法的链接，地址栏变了，但右边面板没开也没切，因为那个 hook 只在 popstate 时重新同步，而 Next.js 的软导航改 URL 不发 popstate。这版改成直接从 `useSearchParams()` 取选中状态。

**daemon 聊天弹窗在手机上铺满了整屏**，输入框钉在底部；宽的 markdown 块（表格、代码、长链接）也收回了 transcript 里面，不再横向溢出。@-mention 下拉框里每个 Agent 候选项现在带上了在线状态，绿点加一行"N 个在行"或"空闲"，@ 它之前就知道它在不在、忙不忙。

**三个插件版本对齐到 0.11.0。** Claude Code、Codex、OpenClaw 三个包加上独立的 `/skill/` 分发，全部对齐。

---

## 升级

```bash
npx @chorus-aidlc/chorus@latest
```

起一个 daemon（目前只支持 Claude Code 作为本地 Agent 后端）：

```bash
npx @chorus-aidlc/chorus daemon
```

Claude Code 插件：

```bash
/plugin marketplace update chorus-plugins
```

Codex 插件按 release 文档重新装一次。

OpenClaw 插件：

```bash
npm i -g @chorus-aidlc/openclaw-plugin@latest
```

这版带几个 DDL 迁移（daemon 连接、执行状态、会话、turn 几张表），没有数据迁移，跑一次 `prisma migrate` 即可。

v0.11.0 已发布到 [GitHub Releases](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.11.0) 和 [npm](https://www.npmjs.com/package/@chorus-aidlc/chorus)。

有问题或反馈？[GitHub Issues](https://github.com/Chorus-AIDLC/Chorus/issues) 或 [Discussions](https://github.com/Chorus-AIDLC/Chorus/discussions)。

---

**GitHub**: [Chorus-AIDLC/Chorus](https://github.com/Chorus-AIDLC/Chorus) | **Release**: [v0.11.0](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.11.0)
