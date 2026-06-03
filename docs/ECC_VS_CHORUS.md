# ECC（Everything Claude Code）研究 + 与 Chorus 对比

> 研究报告 · 2026-06-01
> 范围：深入研究 `/home/ubuntu/dev/ECC`（Everything Claude Code，下称 ECC）的整体定位与核心机制，对比 Chorus（AI-DLC 协作平台）当前实现，评估两者的优劣差距与可落地启发。
> 信息来源：ECC 侧以本仓库源码与文档为准（`/home/ubuntu/dev/ECC`，version `2.0.0-rc.1`）；Chorus 侧以本仓库源码、`docs/`、插件 skill 为准（version `0.9.1`）。与本仓库已有的 `docs/CLAUDE_CODE_DYNAMIC_WORKFLOWS_VS_CHORUS.md` 互补：那篇讲「单会话内的执行引擎」，本篇讲「客户端侧的 Agent 工程操作系统」。

---

## 0. 执行摘要（给决策者）

- **ECC 是什么**：ECC 不是一个产品平台，而是一套**客户端侧（client-side）的「Agent 工程操作系统」**，以纯文件（Markdown + JSON + Node.js 脚本）形态分发，安装进各类 AI 编码 harness 的本地配置目录（`~/.claude`、`./.cursor` 等）。它把「怎么用好 AI 写代码」的所有经验沉淀成四类可安装资产：**63 个 Agent、249 个 Skill、79 个 Command、一整套 Hook + Rule**，外加一个**选择性安装引擎**、**跨 11+ harness 移植层**、**持续学习/自进化机制**，以及正在用 Rust 重写的 **ECC 2.0 控制平面**。

- **Chorus 是什么（对照）**：Chorus 是**服务端侧（server-side）的持久化协作平台**，以 Next.js + PostgreSQL 实现 AI-DLC 业务生命周期（Idea → Proposal → Task → Execute → Verify → Done），核心哲学是 **"Reversed Conversation"**（AI 提议、人验证），状态落库、多租户、人在环路、可审计。Chorus 自己也分发两个插件（Claude Code 插件 `public/chorus-plugin/`、Codex 插件 `plugins/chorus/`），但插件只是**薄薄的 MCP 客户端 + skill 工作流**，真正的状态机和业务逻辑在服务端。

- **两者的根本关系**：**层级不同，且高度互补。** ECC 解决的是「单个开发者/单个 harness 内，如何把 AI 用到production-grade」——它的资产活在本地文件系统，作用于一次次编码会话。Chorus 解决的是「跨会话、跨 Agent、跨人，如何把 AI 产出纳入可治理、可审计的协作流水线」——它的状态活在数据库，作用于一个团队的长期协作。**ECC 是「纵向打深单机体验」，Chorus 是「横向打通协作治理」。** 一个团队完全可以同时用两者：每个工程师本地装 ECC 提升单机产出质量，团队层面用 Chorus 做编排与验收。

- **最大启发（三条）**：
  1. **资产分发与选择性安装**：ECC 的「manifest 驱动 + profile + 依赖解析 + 跨 harness 适配器」是把「一堆 skill/agent」工程化分发的成熟范本。Chorus 插件目前是「整包塞给用户」，可借鉴 ECC 的模块化分发思路（见 §6.1）。
  2. **Hook 即治理执行层**：ECC 用客户端 Hook（GateGuard 事实强制门、危险命令拦截、成本追踪、上下文监控）把「规则」变成「会真的拦住你的执行层」。Chorus 的治理目前停在服务端状态机和 skill 提示层，**缺少在 Agent 本地执行点的强制闸门**——这正是 ECC 最值得借鉴的工程化能力（见 §6.2）。
  3. **持续学习/自进化闭环**：ECC 的 instinct 模型（观测 → 原子 instinct → 置信度累积 → 聚类 → 进化成 skill/command/agent，且项目级 vs 全局级分层）是「让 Agent 体系自我改进」的完整设计。Chorus 有完整的 Activity Stream 和 Elaboration 审计轨迹，**但没有把这些沉淀回流成可复用资产的闭环**（见 §6.3）。

- **一句话结论**：ECC 验证了「Agent 工程的价值不在更强的模型，而在围绕模型的基础设施（skill / hook / rule / 持续学习 / 跨 harness 移植）」。Chorus 应当**借鉴 ECC 的客户端工程化能力来强化自己的插件层与治理执行层**，同时清醒认识到两者护城河正交：Chorus 的不可替代性在「服务端持久化协作 + Reversed Conversation + 多租户治理」，这是 ECC（纯客户端文件分发）做不到也不想做的。

---

## 1. ECC 是什么 / 如何定位

### 1.1 一句话定义

> ECC 是一套以纯文件形态分发的、跨 AI 编码 harness 的「Agent 工程资产库 + 安装引擎 + 自进化机制」，目标是把「用好 AI 写代码」的全部 know-how 沉淀成可安装、可移植、可演化的本地配置。

`SOUL.md` 原文：

> Everything Claude Code (ECC) is a production-ready AI coding plugin with 30 specialized agents, 135 skills, 60 commands, and automated hook workflows for software development.

`AGENTS.md` 自报当前规模（version `2.0.0-rc.1`）：63 agents、249 skills、79 commands。`README` 的市场定位则更宏大：「The harness-native operator system for agentic work」（面向 Agent 工作的、harness 原生的操作员系统）。

### 1.2 五条核心原则（`AGENTS.md` / `SOUL.md`）

1. **Agent-First**：尽早把工作路由给专门的 specialist agent。
2. **Test-Driven**：实现前先写测试，要求 80%+ 覆盖率。
3. **Security-First**：永不在安全上妥协，所有输入都校验。
4. **Immutability**：永远造新对象，不原地修改。
5. **Plan Before Execute**：复杂改动先规划再写码。

> 这五条本身就和 Chorus 的工程价值观高度一致（Chorus 也强调测试、安全、AC 验收）。差异在**落地形态**：ECC 把它们写进 always-on 的 Rule 和会拦截执行的 Hook；Chorus 把它们写进 AC、skill 提示和服务端闸门。

### 1.3 整体架构（六类资产 + 三套引擎）

```
ECC 仓库
├── 四类可安装资产
│   ├── agents/    63 个 specialist subagent（.md + YAML frontmatter）
│   ├── skills/    249 个知识模块（SKILL.md + references/）
│   ├── commands/  79 个 slash 命令（正在向 skills 迁移，commands 转薄 shim）
│   └── rules/ + hooks/  always-on 规则 + 生命周期 Hook
├── 三套引擎/层
│   ├── 选择性安装引擎  manifests/ + scripts/install-*.js（profile + 依赖解析 + 适配器）
│   ├── 跨 harness 移植层  11+ harness 的 dot-dir + agent.yaml（gitagent 协议）
│   └── 持续学习/自进化  continuous-learning-v2（instinct 模型 + /evolve + /promote）
└── ECC 2.0（ecc2/，Rust）  多会话编排控制平面（alpha，SQLite session store + TUI + daemon）
```

---

## 2. ECC 的核心机制（逐项拆解）

### 2.1 Agents（63 个）—— 文件化的 specialist

- **形态**：每个 agent 是一个 `.md`，YAML frontmatter 含 `name / description / tools / model / color`。`tools` 是白名单，`model` 指定 opus/sonnet/haiku 分层。
- **类型**：工作流类（planner、architect、tdd-guide、code-reviewer、security-reviewer、build-error-resolver、refactor-cleaner、doc-updater）、语言专家（typescript/python/go/java/kotlin/rust/cpp/django/... 的 reviewer + build-resolver）、自动化类（loop-operator、harness-optimizer）。
- **编排哲学**：「主动调用」——代码改完自动 → code-reviewer，复杂需求 → planner，安全敏感 → security-reviewer，且鼓励并行 dispatch 独立 agent。
- **质量设计亮点**：
  - **code-reviewer 的置信度过滤**：只报 >80% 置信度的问题；写每条 finding 前必须过「能引用确切行号吗？能描述具体失败模式吗？读了上下文吗？严重度站得住吗？」四问门；明确「零发现是合法的，不要硬造问题」，还附「常见误报清单」。
  - 这套「先自我设限、再下结论」的设计，正是 Chorus reviewer agent 可以直接借鉴的（见 §6）。

### 2.2 Skills（249 个）—— 被动知识模块

- **形态**：每个 skill 是一个目录，含 `SKILL.md`（frontmatter: `name / description / origin / version / tags`），可带 `references/` 子目录放深度参考。典型 200-500 行，上限 800 行。
- **核心原则**（`SKILL-DEVELOPMENT-GUIDE.md`）：「Show, don't tell」——每个 pattern 都要有可复制的代码例子；反模式（anti-pattern）和正模式同等重要。
- **触发**：**无中心 registry**，靠 Claude 读 `description` + `## When to Activate` 上下文自动激活。安装时由 `manifests/install-modules.json` 决定哪些 skill 装进哪个 harness。
- **分类**（按安装模块）：framework-language（~50，各语言/框架 pattern）、workflow-quality（TDD、eval-harness、verification-loop）、security、research-apis、business-content、operator-workflows、agentic-patterns、devops-infra、media-generation、swift-apple 等。
- **放置策略**（`SKILL-PLACEMENT-POLICY.md`）：curated（仓库内 `skills/`，随包分发）/ learned（`~/.claude/skills/learned/`，需 provenance）/ imported / evolved（自进化产物）四类分层，**只有 curated 随包发**。

> 与 Chorus 的 skill 对比：Chorus 的 skill（`public/skill/`、`public/chorus-plugin/skills/chorus/`）是**流程编排型**（描述 idea/proposal/develop/review/yolo 工作流如何调 MCP 工具），数量少（约 8 个）、强耦合 Chorus 平台。ECC 的 skill 是**知识/模式型**，数量大（249）、平台无关。两者不是同一物种：ECC skill ≈ Chorus 的「领域知识库」（Chorus 目前没有），Chorus skill ≈ ECC 的 command（用户/Agent 调用的工作流入口）。

### 2.3 Commands（79 个）—— 正在退役的入口层

- **形态**：`.md` + frontmatter（`description / argument-hint`）。
- **现状**：`AGENTS.md` 的「Workflow Surface Policy」明确 **skills 是 canonical 工作流面，commands 是 legacy 兼容 shim**，新工作流先落 skills。
- **值得注意的多 Agent 编排命令**：`/multi-plan`、`/multi-execute` 实现了**多模型 fan-out**——把规划/原型任务并行派给外部模型后端（Codex 管后端、Gemini 管前端），外部模型**只返回 Unified Diff 补丁、零文件写权限**，由 Claude 统一 refactor 落地。这套「外部模型当脏原型机、主模型当唯一落地者」的 code sovereignty 设计很精巧。

### 2.4 Hooks —— ECC 最硬核的工程化能力

这是 ECC 区别于「一堆提示词」的关键：**它把规则变成会真的拦住执行的客户端闸门。**

- **机制**：`hooks/hooks.json` 注册生命周期 Hook（PreToolUse / PostToolUse / Stop / SessionStart / SessionEnd / PreCompact / PostToolUseFailure），matcher 匹配工具（Bash/Edit/Write/*），PreToolUse 可**阻断**（exit code 2）或**仅警告**（exit 0 + stderr）。有 `minimal/standard/strict` 三档 profile，支持 `ECC_DISABLED_HOOKS` 按 ID 关闭。
- **代表性 Hook**：
  - **GateGuard 事实强制门**（`gateguard-fact-force.js`）：核心哲学是「别问『你确定吗』（LLM 永远答确定），而是**强制它先摆出事实**」。首次编辑某文件前，必须先列出所有 importer、受影响的公开函数、数据 schema，并逐字引用用户指令；新建文件前要确认没有现成文件做同样的事；危险 Bash（`rm -rf`、`git reset --hard`、`drop table` 等）前要列出受影响文件 + 写一行回滚步骤。**调查的动作本身制造了自我评估永远制造不出的觉察。**
  - **危险命令拦截**：`block-no-verify`（禁 `git --no-verify` 绕过 hook）、`auto-tmux-dev`（强制 `npm run dev` 在 tmux 里跑以便读日志）、`config-protection`（禁止改 linter/formatter 配置，逼 Agent 改代码而非弱化规则）。
  - **成本追踪**（`cost-tracker.js`）：Stop 时从 transcript JSONL 汇总 token，按 Haiku/Sonnet/Opus 费率表估算，优先采信 statusline 写的权威 `cost.total_cost_usd`，逐行写 `~/.claude/metrics/costs.jsonl`。
  - **上下文监控**（`ecc-context-monitor.js`）：上下文耗尽（≤35% 警告/≤25% 危急）、高成本（$5/$10/$50 三档）、scope creep（改了 20+ 文件）、工具死循环（3 次相同调用）时注入面向 Agent 的警告。
  - **持续学习观测器**（`observe.sh`）：PreToolUse/PostToolUse 上 100% 捕获工具调用为 JSONL，带 5 层防自观测循环过滤、密钥擦除、10MB 自动归档。

> 这是 Chorus **完全缺失的一层**。Chorus 的治理在服务端（状态机、AC 闸门、权限），但**在 Agent 本地执行点没有任何强制闸门**。当 Chorus Agent（Claude Code/Codex 插件）在本地跑 `/develop` 改代码时，没有 GateGuard 式的「改文件前先摆事实」、没有危险命令拦截、没有成本警告。这正是 §6.2 的重点启发。

### 2.5 Rules —— always-on 基线

- **形态**：`rules/common/`（语言无关：security/testing/git-workflow/coding-style/...）+ 每语言子目录（typescript/python/go/...），装进 `~/.claude/rules/ecc/`。
- **与 skill 的区别**：Rule 是**始终生效**的标准/清单（如「80% 覆盖率」「无硬编码密钥」「不可变」），skill 是**按需激活**的深度参考。语言规则覆盖通用规则（specific overrides general）。

> Chorus 的对应物是 `CLAUDE.md`（项目级 always-on 指令）。差异：ECC 的 Rule 是**可选择性安装、分语言、跨 harness**的；Chorus 的 `CLAUDE.md` 是单文件、项目级。

### 2.6 选择性安装引擎 —— 把资产库工程化分发

- **三层 manifest**：`install-modules.json`（28+ 原子模块，每个声明 `paths/targets/dependencies/defaultInstall/cost/stability`）→ `install-profiles.json`（6 个 profile：minimal/core/developer/security/research/full）→ `install-components.json`（面向用户的友好 ID，如 `lang:typescript`、`framework:nextjs`、`skill:<id>`）。
- **依赖解析**：`scripts/install-plan.js`（只读预演）+ `install-apply.js`（执行），递归解析模块依赖（如 `security` → `workflow-quality`），按 target 兼容性过滤，生成 typed 操作计划（copy / merge-json / flatten）。
- **生命周期**：install-state 落 `~/.claude/ecc/install-state.json`，支持 `doctor`（检测漂移）/`repair`（按 state 恢复）/`uninstall`（只删 ECC 管理的文件）。

> Chorus 插件目前是**整包安装**（一个 plugin 带固定的 skill/agent 集）。当 Chorus 的 skill/agent 增多、或要支持「按团队角色裁剪」时，ECC 这套 profile + 依赖解析是现成范本（见 §6.1）。

### 2.7 跨 harness 移植层 —— 单一真源，11+ 目标

- **支持的 harness**：Claude Code、Codex、Cursor、OpenCode、Gemini、Qwen、Zed、CodeBuddy、JoyCode、Antigravity，加上 Hermes/OpenClaw 等的手工迁移指南。
- **机制**：**单一内容图**（一份 `rules/agents/skills/commands/hooks`）+ **per-target 适配器**（安装时 remap）。如 Cursor 适配器把 `rules/*.md` 拍平重命名成 `.cursor/rules/*.mdc`、合并 `mcp.json`；Antigravity 把 commands → `.agent/workflows/`、agents → `.agent/skills/`。
- **gitagent 协议**（`agent.yaml`）：跨平台 agent 发现的导出面，列出全部 skill + command + 偏好模型。

> Chorus 已经在做类似的事但**更窄**：它为 Claude Code 和 Codex 各维护一个独立插件包（见项目记忆 [[project_two_plugins]]），还有 OpenClaw 插件。ECC 的「单一真源 + 适配器」比 Chorus 的「每 harness 独立维护一份」更可扩展。这是 Chorus 插件层可借鉴的架构（但优先级低于 §6.2/§6.3，因为 Chorus 插件主要是 MCP 客户端，移植成本本来就低）。

### 2.8 持续学习 / 自进化 —— instinct 模型

ECC 最有想象力的部分。完整闭环：

```
会话活动（git 仓库内）
   │ PreToolUse/PostToolUse Hook 100% 捕获工具调用 + 按 git remote 哈希识别项目
   ▼
observations.jsonl（项目级目录）
   │ 后台 Haiku observer 分析模式（用户纠正 / 错误解决 / 重复工作流）
   ▼
instinct（原子学习单元）：一个 trigger + 一个 action + confidence(0.3-0.9) + domain + evidence + scope
   │ 项目级（默认）vs 全局级（在 2+ 项目出现且均值置信度 ≥0.8 自动晋升）
   ▼
/evolve 聚类 → 生成 skill（自动触发型）/ command（用户调用型）/ agent（多步复杂型）
```

- **v2 相对 v1 的关键改进**：观测从「Stop hook（会话末，会漏）」改成「Pre/Post Hook（100% 可靠）」；分析从主上下文挪到后台 Haiku；粒度从「直接造完整 skill」改成「原子 instinct 累积置信度再聚类」；新增**项目级/全局级 scope** 防止跨项目污染（React pattern 不会泄漏到 Python 项目）。
- **隐私优先**：观测留本地，只有 instinct（模式）可导出，原始代码/对话不外传。
- **`/skill-create`**：从 git 历史提取 commit 约定、文件协变、工作流序列，生成 skill。

> Chorus 有海量结构化的协作数据（Activity Stream、Elaboration 问答、Proposal/Task 历史、AC 验收结果），**比 ECC 的本地 JSONL 观测质量高得多、且天然落库**，但 Chorus **完全没有把这些回流成可复用资产的机制**。这是 §6.3 的核心启发，也是 Chorus 相对 ECC 反而**数据基础更好**的地方。注意 Chorus 项目组里已有一个 "Self-Evolving Coding Agent" 项目和 [[project_codex_skill_prefix]] 相关的自进化探索，说明团队对这个方向有兴趣。

### 2.9 自治循环 + ECC 2.0 控制平面

- **自治循环**：`loop-operator` agent + `loop-status.js`（监控 Claude transcript，检测超时未返回的 Bash、逾期的 ScheduleWakeup），文档化了 6 种循环架构（顺序管线 / NanoClaw REPL / 无限 agentic loop / 持续 PR loop / de-sloppify / RFC-DAG）。安全边界：自治操作必须用户显式授权、优先 dry-run。
- **ECC 2.0**（`ecc2/`，Rust，alpha）：定位「harness 操作系统」——分层为 Operator Surface / Harness Adapter / Worktree-Session-Queue Runtime / Observability-Eval Loop / Security-Commercial Platform。已有 SQLite session store、TUI dashboard、daemon、worktree 感知的会话脚手架。

> 有意思的对照：ECC 2.0 想做的「多会话编排控制平面 + 可观测 + session store」，**Chorus 服务端早就做了**（AgentSession + SessionTaskCheckin + Activity Stream + Web UI）。ECC 是从「客户端文件」往「服务端控制平面」长，Chorus 是天生的服务端平台。两者在「会话可观测性」这个点上正在**从两端相向而行**。

### 2.10 Token 优化（`token-optimization.md`）

明确的成本纪律：默认 model 从 opus 改 sonnet（省 ~60%）、`MAX_THINKING_TOKENS` 从 32K 降 10K（省 ~70% 隐藏成本）、subagent 用 haiku（省 ~80%）、按任务类型路由模型（探索用 Haiku、实现用 Sonnet、架构/安全用 Opus）、MCP 保持 <10 个启用（每个都吃上下文）。

> Chorus 的 yolo/develop skill **没有显式的成本/模型路由纪律**。这是低成本、立竿见影的借鉴点。

---

## 3. Chorus 的实现（对照基线）

为公平对比，精确描述 Chorus 自己的形态（以本仓库源码 + `CLAUDE.md` + 插件 skill 为准）。

### 3.1 服务端持久化平台

- **技术栈**：Next.js 15（App Router）+ TypeScript + PostgreSQL 16 + Prisma 7 + Redis（可选）+ MCP HTTP Streamable。21 张 Prisma 表，UUID-first，多租户（`companyUuid` 边界）。
- **业务生命周期**：Idea → Proposal →（approve 物化）→ [Document + Task] → Execute → Verify → Done。核心哲学 **Reversed Conversation**（AI 提议、人验证）。
- **权限模型**：细粒度 `{resource}:{action}`（5 资源 × 3 动作 = 15 bit），Agent 用 API Key（`cho_` 前缀），工具可见性按权限集驱动。

### 3.2 编排与可观测

- **Session/Swarm**：`AgentSession` 记录子 Agent 集群，心跳/过期（60min stale）/checkin-checkout 任务，把「Agent 可用性」与「任务分配」解耦。
- **任务依赖 DAG**：`TaskDependency` 表 + 环检测 + `getUnblockedTasks`（只有 `done`/`closed` 才解锁下游）。
- **Activity Stream**：`Activity` 表记录所有动作，含 `sessionUuid + sessionName`（去规范化），实时事件总线推送。
- **验收 + 验证**：`AcceptanceCriterion` 双轨（开发自检 + Admin 验证），闸门阻断 `to_verify → done` 除非所有 required AC passed。

### 3.3 客户端插件（薄层）

- **Claude Code 插件**（`public/chorus-plugin/`）：skill（chorus/idea/proposal/develop/review/yolo/brainstorm/quick-dev/openspec-aware）+ 2 个 reviewer agent（proposal-reviewer、task-reviewer）+ session 生命周期 hook。
- **`/yolo`**：已实现全自动流水线，且**已有对抗式验证和收敛循环雏形**——Phase 2 proposal-review loop（最多 3 轮）、Phase 3 wave 执行（barrier 式分波并行）、Phase 4 task-review loop（最多 3 轮）。
- **关键**：插件的「智能」靠 skill 自然语言提示 + 模型逐轮决策；状态机和闸门在服务端。**客户端没有 ECC 式的强制 Hook 层。**

---

## 4. 逐维度对比

| 维度 | ECC（Everything Claude Code） | Chorus |
|------|------------------------------|--------|
| **本质** | 客户端 Agent 工程资产库 + 安装引擎 | 服务端持久化协作平台 |
| **分发形态** | 纯文件（MD+JSON+Node 脚本），装进本地配置目录 | npm 包（服务端 app）+ 薄客户端插件 |
| **状态存储** | 本地文件 + JSONL（observations/costs/sessions） | PostgreSQL（21 表，多租户落库） |
| **作用范围** | 单机、单 harness、单次会话内的编码体验 | 跨会话、跨 Agent、跨人的长期协作 |
| **人机定位** | 单人操作员驾驭 AI（个人产出放大器） | Reversed Conversation：AI 提议、人验证、团队治理 |
| **核心资产** | 63 agent / 249 skill / 79 command / hook / rule | 业务实体（Idea/Proposal/Task/Doc/AC）+ MCP 工具 |
| **治理执行层** | **客户端 Hook**（GateGuard 事实门、危险命令拦截、成本/上下文监控）—— 强 | **服务端状态机 + AC 闸门 + 权限**；**客户端无强制闸门** —— 半 |
| **知识/模式库** | 249 个平台无关 skill（领域知识）—— 强 | 无领域知识库；skill 仅平台工作流 —— 弱 |
| **持续学习/自进化** | instinct 模型完整闭环（观测→进化，项目/全局分层）—— 强 | 有海量优质审计数据但**无回流闭环** —— 数据强、闭环缺 |
| **跨 harness** | 单一真源 + 11+ 适配器（gitagent 协议）—— 强 | 每 harness 独立插件包（CC/Codex/OpenClaw）—— 中 |
| **选择性安装** | manifest + profile + 依赖解析 + doctor/repair —— 强 | 插件整包安装 —— 弱 |
| **成本纪律** | 显式 model 路由 + thinking token + 成本追踪 Hook —— 强 | 无显式成本纪律 —— 弱 |
| **会话可观测** | 本地 transcript 监控 + ECC 2.0 SQLite store（alpha） | AgentSession + Activity + Web UI（成熟、服务端）—— 强 |
| **多 Agent 编排** | 多模型 fan-out（Codex/Gemini 后端）+ 自治循环 | wave 调度 + reviewer loop（服务端 DAG 驱动）—— 强 |
| **持久化/续跑** | session 文件 save/resume（本地 .tmp） | 天然续跑：所有实体落库，Ctrl+C 可接力 —— 强 |
| **人在环路/审计** | 弱（单机，无多人协作概念） | 强（Activity 审计轨迹 + Elaboration + 权限 + Web UI） |
| **可治理/合规** | ECC 2.0 规划 AgentShield（未 GA） | 多租户 + 权限 + 审计已是一等公民 —— 强 |

**一句话对比**：ECC 在「单机 Agent 体验的工程化深度（hook 治理 / 知识库 / 自进化 / 跨 harness / 成本纪律）」上极强；Chorus 在「服务端持久化协作（人在环路 / 审计 / 多租户 / 业务生命周期 / 续跑）」上极强。**两者强项几乎完全正交。**

---

## 5. 优劣差距分析

### 5.1 ECC 有、Chorus 缺（值得追赶/借鉴）

1. **客户端强制治理层（Hook）**：Chorus 治理在服务端，Agent 本地改代码时没有任何「先摆事实再动手」「拦截危险命令」「成本超标警告」的执行闸门。**这是最大的能力缺口。**
2. **平台无关的领域知识库**：Chorus 没有「React pattern / TDD workflow / API design」这类可被 Agent 复用的领域知识 skill。Chorus 的 Agent 执行任务时，领域知识全靠基座模型自带。
3. **自进化闭环**：Chorus 攒了一堆优质协作数据却没回流。ECC 的 instinct → evolve → skill/agent 闭环是现成蓝图。
4. **选择性安装与模块化分发**：Chorus 插件整包发，无 profile/裁剪。
5. **显式成本纪律**：模型路由、thinking token 控制、成本追踪。
6. **置信度过滤式 review**：ECC code-reviewer 的「>80% 置信度 + 四问门 + 误报清单 + 零发现合法」，比 Chorus reviewer 的纯文本 VERDICT 更严谨。

### 5.2 Chorus 有、ECC 缺（护城河，不要丢）

1. **服务端持久化 + 多租户**：ECC 是单机文件，没有「公司/团队/项目组」边界，没有跨人协作。
2. **Reversed Conversation + 人在环路治理**：ECC 是「单人操作员驾驭 AI」，没有「AI 提议、多个 stakeholder 验证」的协作模型。
3. **业务生命周期状态机**：Idea→Proposal→Task→Verify 的结构化流水线 + 物化原子事务 + AC 双轨验收，ECC 没有对等物。
4. **天然续跑**：所有状态落库，比 ECC 的本地 session .tmp 文件强得多。
5. **可审计性**：Activity Stream + Elaboration 审计轨迹是合规/团队协作的刚需，ECC（单机）不需要也没有。
6. **实时协作**：SSE/Redis 事件总线、通知、@mention，多人实时看到同一项目状态。

### 5.3 微妙的趋同点

ECC 2.0 想做的「多会话编排控制平面 + session store + 可观测」，恰恰是 Chorus 服务端的强项。**ECC 在从客户端往服务端长，Chorus 是天生服务端。** 如果 ECC 2.0 成熟，它在「会话编排」上会和 Chorus 有部分重叠——但 ECC 2.0 仍是单机/单操作员控制平面，不碰多租户协作治理。**重叠区是「会话可观测」，正交区是「协作治理」。**

---

## 6. 对 Chorus 的可落地启发

按「价值/成本」分三层。

### 6.1 借鉴层（模式，低成本）

- **I1 · reviewer 置信度门**：把 ECC code-reviewer 的「>80% 置信度 + 四问门（能引用行号？能描述失败模式？读了上下文？严重度站得住？）+ 误报清单 + 零发现合法」注入 Chorus 的 `proposal-reviewer` / `task-reviewer` agent 定义。低成本、立竿见影地降低 reviewer 噪声。（呼应已有的 [[feedback_no_silent_errors]] —— 不静默、但也不硬造。）
- **I2 · 显式成本/模型路由纪律**：在 `/yolo`、`/develop` skill 里加入 ECC 式的模型分层建议（探索用 haiku、实现用 sonnet、架构/安全用 opus）+ wave 规模与 token 预算护栏。
- **I3 · 结构化 reviewer 输出**：reviewer 返回 `{verdict, blockers[], acEvidence[]}` JSON 而非纯文本 `VERDICT:`（这条已在 `CLAUDE_CODE_DYNAMIC_WORKFLOWS_VS_CHORUS.md` R2 提过，两份报告共识，应优先做）。

### 6.2 集成层（能力，中-高价值）—— 客户端治理 Hook

**这是 ECC 给 Chorus 最独特的启发：把治理从「服务端状态机」延伸到「Agent 本地执行点」。**

- **I4 · Chorus 插件 GateGuard**：在 Chorus Claude Code 插件里加一组 PreToolUse Hook，让 Agent 在执行 Chorus 任务、改代码前被强制：
  - **改文件前**：先摆出受影响的 importer / 公开接口 / 数据 schema（ECC GateGuard 模式）。
  - **危险命令前**：拦截 `rm -rf`、`git reset --hard`、`git push --force` 等，要求写回滚步骤。
  - **任务边界检查**：改的文件是否在当前 Chorus 任务的 scope 内？超出则警告（呼应 Chorus 任务粒度/依赖 DAG）。
  - **落库**：Hook 捕获的「事实摆出」「危险操作」可作为 evidence 写回 Chorus Activity Stream / AC 自检，让服务端审计轨迹更丰富。
- **I5 · 成本/上下文监控 Hook 落库**：ECC 的成本追踪 + 上下文监控 Hook，输出可写回 Chorus Session（`AgentSession` 加成本/上下文字段），让 Web UI 能显示「这个 session 花了多少 token、上下文压力多大」。Chorus 已有 session 可观测基础设施，加这层数据成本低、价值高。

> 注意：Chorus 插件目前主要是 MCP 客户端 + skill。加 Hook 层意味着插件要带 Node 脚本（和 ECC 一样），需评估对插件分发与 Bash 3.2 兼容性（见 [[project_two_plugins]] 约束）的影响。

### 6.3 哲学/长期层 —— 自进化闭环

- **I6 · Chorus 协作数据回流成可复用资产**：Chorus 的 Activity Stream / Elaboration 问答 / Proposal 模式 / AC 验收结果，是**比 ECC 本地 JSONL 质量高得多的结构化学习语料**。可建一条类 instinct 的闭环：
  - 从「被反复拒绝的 proposal 模式」「高频 elaboration 问题」「常见 AC 失败原因」中提炼 **项目级 instinct**。
  - 在 2+ 项目复现的 instinct 晋升为 **公司级/全局** 的 proposal 模板、elaboration 问题库、AC 清单。
  - 让 PM agent 起草 proposal 时自动注入这些学到的模式（减少拒绝轮次），让 reviewer 自动套用学到的 AC 清单。
  - 与已有的 "Self-Evolving Coding Agent" 项目方向呼应。
- **I7 · 领域知识 skill 库（探索性）**：评估 Chorus 是否需要一层「平台无关的领域知识 skill」供 Agent 执行任务时复用（类 ECC 的 framework-language skill）。优先级低——Chorus 的差异化不在这里，且基座模型自带大量领域知识；但若 Chorus 要支持「团队私有最佳实践注入」，这是路径。

### 6.4 建议优先级

| # | 启发 | 层 | 成本 | 价值 | 建议批次 |
|---|------|----|----|----|--------|
| I1 | reviewer 置信度门 | 借鉴 | 低 | 中-高 | 第一批 |
| I3 | reviewer 结构化输出 | 借鉴 | 低 | 中 | 第一批（与 WF 报告 R2 合并） |
| I2 | 成本/模型路由纪律 | 借鉴 | 低 | 中 | 第一批 |
| I4 | 插件 GateGuard 治理 Hook | 集成 | 中-高 | 高 | 第二批（核心差异化能力） |
| I5 | 成本/上下文监控落库 | 集成 | 中 | 中-高 | 第二批 |
| I6 | 协作数据自进化闭环 | 哲学 | 高 | 高 | 探索 spike |
| I7 | 领域知识 skill 库 | 哲学 | 高 | 中 | 暂缓/观察 |

> 与姐妹报告（动态 Workflow）的关系：那篇的 R1-R6 聚焦「执行引擎」（pipeline 语义、对抗验证、loop-until-dry、workflow 后端）；本篇聚焦「客户端工程化」（治理 Hook、自进化、成本纪律、reviewer 严谨度）。**两份不冲突，可合并成一个「Chorus 客户端/执行层强化」的大方向。**

---

## 7. 风险与注意事项

1. **不要本末倒置**：ECC 的强项是「单机 Agent 体验」，Chorus 的护城河是「服务端协作治理」。借鉴 ECC 的工程化能力（hook/自进化/成本纪律）是为了强化 Chorus 的**执行与插件层**，绝不是把 Chorus 改造成「又一个客户端资产库」。Reversed Conversation + 持久化协作这两条护城河必须守住。
2. **插件 Hook 的分发成本**：加 ECC 式 Hook 意味着 Chorus 插件要带 Node 脚本 + 跨平台兼容（macOS Bash 3.2、Windows）。需评估对插件体积、安装复杂度的影响（参考 [[project_two_plugins]] 与 [[project_openclaw_plugin_ts_dist]] 的分发约束教训）。
3. **自进化的数据隐私**：Chorus 是多租户的，instinct 回流必须严格按 `companyUuid` 隔离，绝不能跨公司污染（比 ECC 单机场景的隐私要求更高）。
4. **成本纪律不能伤体验**：ECC 把默认模型降到 sonnet 是激进的省钱策略；Chorus 面向「production-grade 协作产出」，模型降级要谨慎，宁可给「可配置 + 智能路由」而非「一刀切降级」。
5. **ECC 仍在快速演进**：ECC 2.0 是 alpha，instinct 机制是 v2.1，部分能力（AgentShield、ECC Tools）尚未 GA。借鉴成熟模式（hook、reviewer 门、成本追踪）风险低；借鉴 alpha 能力（控制平面）应观望。

---

## 8. 参考来源

ECC 侧（`/home/ubuntu/dev/ECC`，version `2.0.0-rc.1`）：
- 定位/原则：`SOUL.md`、`AGENTS.md`、`CLAUDE.md`、`README.md`、`the-shortform-guide.md`
- Agents/Commands：`agents/*.md`（planner/code-reviewer/security-reviewer/tdd-guide/architect/loop-operator/harness-optimizer/...）、`commands/*.md`（multi-plan/multi-execute/plan/code-review/learn/skill-create/evolve/sessions/save-session/...）
- Hooks/Rules：`hooks/hooks.json`、`scripts/hooks/gateguard-fact-force.js`、`scripts/hooks/cost-tracker.js`、`scripts/hooks/ecc-context-monitor.js`、`rules/common/*.md`
- 安装/移植：`manifests/install-{modules,profiles,components}.json`、`scripts/install-{plan,apply}.js`、`agent.yaml`、`docs/SELECTIVE-INSTALL-ARCHITECTURE.md`、`docs/MANUAL-ADAPTATION-GUIDE.md`
- 自进化：`skills/continuous-learning-v2/`、`docs/continuous-learning-v2-spec.md`、`commands/evolve.md`、`commands/skill-create.md`
- 自治/2.0：`skills/autonomous-agent-harness/`、`scripts/loop-status.js`、`docs/ECC-2.0-REFERENCE-ARCHITECTURE.md`、`docs/ECC-2.0-GA-ROADMAP.md`、`docs/token-optimization.md`

Chorus 侧（本仓库，version `0.9.1`）：
- `CLAUDE.md`、`docs/ARCHITECTURE.md`、`docs/MCP_TOOLS.md`、`docs/PRD_Chorus.md`
- `src/services/{session,task,proposal,activity}.service.ts`
- `public/chorus-plugin/skills/chorus/{yolo,develop,review,proposal,idea}/SKILL.md`、`public/chorus-plugin/agents/{proposal-reviewer,task-reviewer}.md`
- 姐妹报告：`docs/CLAUDE_CODE_DYNAMIC_WORKFLOWS_VS_CHORUS.md`
