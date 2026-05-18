# 我把 OpenSpec 揉进开发流程里了，让 Claude Code 自己学着用

最近想把 [OpenSpec](https://github.com/Fission-AI/OpenSpec) 集成进自己的 coding agent 工作流，让 Claude Code 自己用，省得我还得手动调 skill 或者敲命令行。做完发现思路挺通用，分享一下。

我自己做了几个月一个开源项目叫 [Chorus](https://github.com/Chorus-AIDLC/Chorus)，本质上是一个带前端的 agent harness，负责驱使 Claude Code 跑完整条开发流程：你扔一个粗糙的想法进去，它先和你聊清楚想做什么，接着写计划、拆任务、自己干活、自己 review，最后把验收完的成果交回来。整个过程它在 drive，人只在关键节点拍板。

## 为什么想接 OpenSpec

OpenSpec 是社区一个 spec-driven 开发 CLI，思路很清爽。所有 spec 都以文件形式躺在仓库里，用一个固定的目录约定组织。每次 change 是 `openspec/changes/<slug>/`，里面 `proposal.md`、`design.md`、`specs/<capability>/spec.md` 各自一份 markdown。spec 不写完整状态，写 delta，用 `## ADDED Requirements` 这种块表达"这次改了什么"。change 落地后跑一次 `openspec archive <slug>`，CLI 自己把 delta 合进长期 spec。

挺好的工具，但用起来有个挺现实的问题，每一步都得人去推。开新 change 要记得 `openspec new change`，写完要记得 `openspec validate`，change 完成后要记得 `openspec archive`。少一步整套约定就破了，下一次 change 写出来跟前一次接不上。

而 Chorus 本来就在驱动整条开发流程，它知道现在是在和用户聊想法、还是在写计划、还是 task 全部干完准备收尾。这些信号天然就是 OpenSpec 命令该不该触发的依据。让 Chorus 一边驱动流程，一边在合适的节点提醒 agent 跑 OpenSpec 命令，用户就不用学一套新的工具。从他的视角看，他还是在跟 Chorus 用同样的方式聊天写代码，只是中间生成的文档变成了仓库里规范的 spec 文件。

最终效果是 Chorus 在 drive 流程，OpenSpec 在管文档，Claude Code 把两边串起来跑。

## 如何不占用 LLM token 的同时完成文档同步？

具体怎么串？真正的设计难点在这一步：Chorus 是个外部服务，文档存在它的数据库里然后在前端展示，可 OpenSpec 写出来的 spec 文件躺在本地仓库里。怎么把本地文件同步到 Chorus 那边？

最朴素的做法是让 LLM 调 MCP tool 把 markdown 灌到 `content` 参数里。试了一下发现一份完整的 spec 同步一次 content tokens 二十多 K，整个 markdown 要先从 LLM 输出一次再被它重新打字进参数，又费钱又不靠谱，没办法保证 LLM 1:1 完整输出整个文档。

那走 CLI 就好了，写一个同步命令，LLM 只调命令、不碰文件内容。但我又不想让用户额外装一个 cli。

翻了下 Claude Code 文档，发现插件 `bin/` 目录下所有 shell 脚本都会被自动加进 session 的 `PATH`。Chorus 本来就有个 Claude Code 插件，那直接把同步脚本放插件 `bin/` 里就行了。用户装好 Chorus 插件，脚本就跟着到位，agent 在任何路径下都能直接 `chorus-api.sh mcp-tool <tool> "$PAYLOAD"` 调到，不用关心装哪了。再写一个 skill 文件教 CC 什么时候该调它，集成就成立了。

插件结构大概长这样：

```
chorus-plugin/
├── bin/
│   └── chorus-api.sh        # 自动加进 $PATH，agent 直接按名字调
├── hooks/
│   └── hooks.json           # 注册各种生命周期 hook
└── skills/
    └── openspec-aware/
        └── SKILL.md         # 教 CC 什么时候用 chorus-api.sh 同步文档
```

`chorus-api.sh` 完整代码在 [仓库里](https://github.com/Chorus-AIDLC/Chorus/blob/main/public/chorus-plugin/bin/chorus-api.sh)，核心就是 `jq -Rs '.'` 把文件流成 JSON 字符串后塞进 MCP payload，从头到尾 LLM 看不到文件正文。

## 什么时候触发 OpenSpec 的操作？

OpenSpec 的流程从开新 change 到最后 archive，每一步都得在合适的时机被触发。让 agent 自己记得这些时机不靠谱，但 Chorus 本来就在 drive 流程，时机的信号都有，关键是把信号转成对 agent 的提醒。

session 启动是第一个时机。Chorus 插件的 SessionStart hook 顺手检测一下仓库里有没有 `openspec/` 目录、`openspec` CLI 在不在 `PATH` 上，两个都满足就给 session 注入一个标记，skill 文件读到标记就走 OpenSpec 路径，否则维持原来的自由 markdown 路径，老项目完全不受影响。

任务全部验收完是另一个时机，也是我自己最喜欢的一个。OpenSpec 要求每个 change 完成后跑一次 `openspec archive <slug>`，把这次的 delta 合进长期 spec，忘了的话下次写 change 就跟这次接不上。让 agent 自己记得实在不现实，"完成"是好几个 turn 之后才发生的事，agent 早就在想下一件事了。但 Chorus 知道什么时候算完成，所有任务都被验收的那一刻嘛。所以挂了个 PostToolUse hook，每次有任务被验收，hook 顺手查一下这一波相关的任务是不是都 done 了。是的话，就往 agent 的最终回复里注入一条提醒，让它去跑 `openspec archive <slug> -y` 并把生成的长期 spec 同步回 Chorus。

整个流程对用户是隐形的。你只是和 Claude Code 一起完成了一个 feature 的开发，agent 自己就把 OpenSpec 那边该开的开了、该归档的归档了。

## 工具越来越多，人也越来越累

我记得 React 18 和 Vue 3.0 刚出的时候社区一片哀嚎：求求别再出新东西了，学不动了。当时肯定想不到 2026 年工具每周甚至每天都在出，虽然代码是 CC 写的，但为了用好 CC 还是得学一大堆东西。我自己也被铺天盖地的工具烦得不行，像 OpenSpec 这种确实好用，但架不住要学啊。

这次试着把这些工具放进一套流程里，让 CC 自己判断什么时候用、怎么用，自己用下来其实挺舒服的。是不是之后团队配一套共享的开发流程，直接分发给每个成员就行了？

代码都在 [Chorus 仓库](https://github.com/Chorus-AIDLC/Chorus)，OpenSpec 项目在这：https://github.com/Fission-AI/OpenSpec

欢迎讨论。
