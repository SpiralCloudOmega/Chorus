# Claude Code 动态 Workflow 机制研究 + 与 Chorus 对比

> 研究报告 · 2026-05-30
> 范围：Claude Code「动态 Workflow（Dynamic Workflows）」的工作原理与实现要点，及其与 Chorus（AI-DLC 协作平台）多 Agent 编排模型的对比，并给出对 Chorus 的可落地启发清单。
> 信息来源：以本会话内挂载的 `Workflow` 工具完整规格为权威，辅以 Anthropic 官方公开资料交叉验证（见文末「参考来源」）。Chorus 侧均以本仓库源码为准（已标注 `file:line`）。

---

## 0. 执行摘要（给决策者）

- **动态 Workflow 是什么**：Claude Code 在一次会话里，让模型**自己写一段 JavaScript 编排脚本**，由独立 runtime 在后台运行，脚本里用 `agent()` / `parallel()` / `pipeline()` 等原语**确定性地**调度几十到上百个 subagent（硬上限 1000），并支持结构化输出校验、token 预算控制、断点续跑。它解决的是「一个对话装不下的大任务」——代码级审计、几十万行迁移、需要交叉验证的研究。

- **核心范式转变**：传统 subagent / skill 模式下，**模型是编排者**，每一步 spawn 什么由模型逐轮决定，且每个结果都回灌进主上下文。动态 Workflow 把**编排逻辑搬进代码**：循环、分支、中间结果都活在脚本变量里，主上下文**只看到最终答案**。这带来三件事——大规模并行 fan-out、对抗式验证（adversarial verify）、收敛驱动迭代（loop-until-dry）。

- **与 Chorus 的关系**：两者**不是竞品，是不同层级**。Chorus 是**跨会话、跨 Agent、人在环路（human-in-the-loop）的持久化协作平台**，编排粒度是「Idea → Proposal → Task → Verify」的业务生命周期，状态落在 PostgreSQL，可被多个 Agent 和人协同观测。动态 Workflow 是**单会话内、瞬态、全自动的执行引擎**，编排粒度是「函数调用级的 subagent 调度」，状态活在脚本内存里，跑完即弃。

- **最大启发**：Chorus 的 `/yolo` 已经在「用自然语言 prompt 模型逐轮编排 subagent」这条老路上——这恰恰是动态 Workflow 想取代的模式。**Chorus 的任务执行阶段（Phase 3 wave 调度 + Phase 4 验证循环）可以从「模型逐轮决策」升级为「确定性脚本编排」**：把 wave 调度、对抗式 reviewer、收敛判断写成可读、可复跑、可断点续跑的脚本，既省 token 又更可靠。下文第 6 节给出 6 条可直接转成 Proposal 的建议。

- **一句话结论**：动态 Workflow 验证了「确定性编排 + LLM 思考 + 对抗式验证」是大任务的正确形态；Chorus 应当**借鉴它的编排模式（pattern），而非替换自己的持久化协作模型**——把动态 Workflow 当作 Chorus 任务执行阶段的「可选执行后端」，而不是平台的替代品。

---

## 1. 动态 Workflow 是什么 / 如何工作

### 1.1 一句话定义

> 动态 Workflow 是一段由 Claude 即时编写的 JavaScript 编排脚本，由专用 runtime 在与对话隔离的后台环境中执行；脚本以确定性的控制流（循环 / 分支 / fan-out）调度大量 subagent，自我验证后只把最终结果交回会话。

官方文档原话：A dynamic workflow is a JavaScript script that orchestrates subagents at scale. Claude writes the script for the task you describe, and a runtime executes it in the background while your session stays responsive.（[Claude Code Docs](https://code.claude.com/docs/en/workflows)）

### 1.2 触发方式

有三种进入路径（交叉验证自官方文档与 marktechpost 报道）：

1. **在 prompt 里出现 `workflow` 关键字** —— 显式请求一次编排运行。
2. **打开 `ultracode` 设置** —— `ultracode` = `xhigh` 推理强度 + 自动 workflow 编排，对每个实质任务默认走 workflow。
3. **运行内置 workflow** —— 如 `/deep-research`（Claude Code 自带的一个研究型 workflow）。

> 注意：工具规格里明确写了「ONLY call this tool when the user has explicitly opted into multi-agent orchestration」——动态 Workflow **不是默认行为**，必须用户显式 opt-in（关键字 / ultracode / 命名 workflow / 技能指令），因为它可能 spawn 几十个 agent、消耗大量 token。

### 1.3 运行生命周期

```
用户 prompt（含 "workflow" / ultracode）
        │
        ▼
Claude 即时生成 JS 编排脚本（meta + 脚本体）
        │
        ▼  （可选）用户审批 plan
        ▼
Workflow runtime 在隔离环境后台执行脚本
        │
        ├── phase('Scan')   ──► agent() / parallel() / pipeline() 调度 subagent
        ├── phase('Verify') ──► 对抗式 subagent 尝试反驳上一阶段发现
        ├── loop until 收敛  ──► 反复 fan-out 直到 K 轮无新结果
        │
        ▼  （中间结果留在脚本变量，不进主上下文）
        ▼
runtime 跟踪每个 agent 结果（→ 可断点续跑）
        │
        ▼
脚本 return 最终结果 ──► 仅最终答案回灌会话主上下文
```

关键点（官方「How a workflow runs」一节）：
- runtime 在**与对话隔离的环境**里跑脚本，中间结果留在脚本变量里，不落主上下文。
- runtime **逐个跟踪 agent 结果**，这正是「同会话内可断点续跑」的实现基础。
- 工具返回**立即返回一个 task ID**，workflow 在后台跑，完成时投递 `<task-notification>`；会话期间保持响应。

### 1.4 三个标志性能力（公开宣传的卖点）

| 能力 | 含义 | 来源 |
|------|------|------|
| **大规模并行 fan-out** | 单会话内运行「几十到上百个并行 subagent」，绕开「人类工作记忆只能 hold 4-5 个 subagent」的限制——因为编排者是模型 / 脚本，不是人 | claude.com 公告、claudefa.st |
| **对抗式验证（adversarial verification）** | subagent 不只报告发现；**另一批 subagent 的任务是反驳它**。只有挺过反驳的结论才交给用户 | 官方公告、Opus 4.8 release note |
| **收敛驱动迭代（convergence-driven）** | workflow 反复跑直到「答案不再变化」。subagent 数量与迭代轮数**实时**根据任务实际需要决定，而非固定步数 | claudefa.st、marktechpost |

> 实战上限佐证：Jarred Sumner（Bun 作者）公开表示「动态 Workflow + 对抗式 code review」是 6 天内把 Bun 从 Zig 重写为 Rust 的关键之一；Opus 4.8 release note 称可做「跨几十万行代码、从启动到合并的代码库级迁移，以现有测试套件为验收标准」。

---

## 2. 如何实现（技术细节）

以下均依据本会话挂载的 `Workflow` 工具规格（权威），并与官方文档「Behavior and limits」交叉印证。

### 2.1 脚本结构

每个脚本必须以一个**纯字面量** `meta` 对象开头（不允许变量、函数调用、模板插值、展开）：

```js
export const meta = {
  name: 'find-flaky-tests',
  description: 'Find flaky tests and propose fixes',  // 权限弹窗里展示
  phases: [
    { title: 'Scan', detail: 'grep test logs for retries' },
    { title: 'Fix',  detail: 'one agent per flaky test' },
  ],
}
// 脚本体从这里开始 —— 用 agent()/parallel()/pipeline()/phase()/log()
phase('Scan')
const flaky = await agent('grep CI logs for retry markers', { schema: FLAKY_SCHEMA })
```

- `meta` 必填 `name`、`description`；可选 `whenToUse`、`phases`、`model`。
- `phases` 里的 title 必须与脚本里 `phase()` 调用的 title **逐字匹配**，用于进度分组。

### 2.2 核心原语

| 原语 | 语义 | 关键点 |
|------|------|--------|
| `agent(prompt, opts?)` | spawn 一个 subagent，返回其最终文本（或带 `schema` 时返回校验过的结构化对象） | `opts`: `label` / `phase` / `schema` / `model` / `isolation:'worktree'` / `agentType`。用户中途跳过则返回 `null` |
| `parallel(thunks[])` | 并发执行一组任务，**barrier**：等全部完成才返回 | 某个 thunk 抛错 → 该位置 resolve 成 `null`，调用本身永不 reject。用前 `.filter(Boolean)` |
| `pipeline(items, ...stages)` | 每个 item 独立流过所有 stage，**stage 间无 barrier** | item A 可在 stage 3 时 item B 还在 stage 1。墙钟时间 = 最慢单条链，而非「每阶段最慢之和」。**默认首选** |
| `phase(title)` | 开启一个进度分组 | 后续 `agent()` 归入该组 |
| `log(message)` | 向用户发一行进度叙述 | 用于「不静默截断」——丢弃了什么要 log 出来 |
| `workflow(nameOrRef, args?)` | 内联运行另一个 workflow 作为子步骤 | **只能嵌套一层**，子 workflow 里再调 `workflow()` 抛错 |

### 2.3 pipeline vs parallel —— 最关键的语义差异

这是动态 Workflow 设计哲学里最值得学的一点：**默认用 `pipeline()`，barrier 只在真正需要跨 item 全集上下文时才用。**

- **`parallel()` 是 barrier**：在 stage N 需要 stage N-1 的**全部**结果时才正当——比如跨全集去重 / 合并、统计为 0 时早退、stage N 的 prompt 要引用「其它发现」做对比。
- **`pipeline()` 无 barrier**：如果中间只是 flatten / map / filter（无跨 item 依赖），就该放进 pipeline 的某个 stage 里做，而不是用 barrier。
- **气味测试**：如果你写了 `parallel → 一个纯 transform → parallel`，那个中间 transform 不需要 barrier，应重写成 pipeline。barrier 的延迟是真实的：5 个 finder 里最慢的是最快的 3 倍，barrier 就浪费了快 finder 2/3 的空闲时间。

```js
// 典型多阶段模式：pipeline 默认，每个维度一审完就立刻验证
const results = await pipeline(
  DIMENSIONS,
  d => agent(d.prompt, { label: `review:${d.key}`, phase: 'Review', schema: FINDINGS }),
  review => parallel(review.findings.map(f => () =>
    agent(`Adversarially verify: ${f.title}`, { phase: 'Verify', schema: VERDICT })
      .then(v => ({ ...f, verdict: v }))))
)
// 维度 'bugs' 的发现在维度 'perf' 还在 review 时就已经在 verify —— 不浪费墙钟
```

### 2.4 并发模型与上限

| 约束 | 值 | 说明 |
|------|----|----|
| **单 workflow 并发 agent 上限** | `min(16, CPU 核数 - 2)` | 超出的 `agent()` 排队，slot 空出再跑 |
| **单 workflow 全生命周期 agent 总数上限** | **1000** | 防失控循环的兜底，远高于真实 workflow |
| **公开宣传的「上百并行 subagent」** | 受上面两条共同约束 | 你可以给 `parallel()`/`pipeline()` 传 100 个 item，它们都会完成，但任一时刻只有约 10 个在跑 |

> 注意区分：官方「Behavior and limits」是 runtime 级约束；marktechpost 标题里的「capped at 1000 subagents」即指上面的总数上限。

### 2.5 结构化输出（schema）

`agent(prompt, { schema })` 时，subagent 被强制调用一个 `StructuredOutput` 工具，`agent()` 返回**已校验**的对象——无需手动解析。校验发生在工具调用层，不匹配时模型自动重试。这是「让 subagent 返回机器可读数据」的关键：subagent 被告知「你的最终文本就是返回值（不是给人看的消息）」，所以会返回原始数据。

### 2.6 token 预算

`budget` 全局对象承接用户的 `+500k` 式预算指令：
- `budget.total`：本轮 token 目标（无指令时为 `null`）。
- `budget.spent()`：本轮（主循环 + 所有 workflow 共享池）已花的 output token。
- `budget.remaining()`：`max(0, total - spent())`，无目标时为 `Infinity`。
- **硬上限**：`spent()` 达到 `total` 后，再调 `agent()` 直接抛错。

支持两种用法：动态循环（`while (budget.total && budget.remaining() > 50_000) {...}`）或静态扩容（`const FLEET = budget.total ? Math.floor(budget.total/100_000) : 5`）。

### 2.7 worktree 隔离

`agent(prompt, { isolation: 'worktree' })` 给 subagent 一个独立 git worktree。**昂贵**（每个 ~200-500ms 启动 + 磁盘开销），**仅当多个 agent 并行改文件、否则会冲突时才用**；worktree 若无改动会被自动清理。这对应「几十万行代码迁移」场景：每个迁移 agent 在自己的 worktree 里改，互不冲突。

### 2.8 断点续跑（resume / journal）

- 工具结果里含 `runId`。要续跑，用 `Workflow({ scriptPath, resumeFromRunId })`。
- **最长未改动前缀**的 `agent()` 调用直接返回缓存结果；第一个被改动 / 新增的调用及其之后全部 live 重跑。
- 同脚本 + 同 args → 100% 缓存命中。
- 限制：**仅限同一 Claude Code 会话内**。退出 Claude Code 后，下次会话 workflow 从头开始。
- 实现约束：脚本里 `Date.now()` / `Math.random()` / 无参 `new Date()` 都会抛错（否则破坏 resume 的确定性）——时间戳要从 `args` 传入或在 workflow 返回后再盖；随机性靠 agent 的 prompt/label 按 index 变化。

### 2.9 可用性与平台（公开信息）

- **研究预览**（research preview），需 Claude Code **v2.1.154+**。
- 计划可用性：Max / Team 默认开；Enterprise 默认关，需管理员开启；Pro 在 `/config` 里手动开。（不同二手来源措辞略有出入，以官方文档为准。）
- 运行环境：CLI、Desktop、VS Code 扩展。
- 后端：Anthropic API、Amazon Bedrock、Google Vertex AI、Microsoft Foundry。
- 组织级关闭：managed settings 里 `"disableWorkflows": true`。关闭后 bundled workflow 命令不可用、`workflow` 关键字不再触发、`ultracode` 从 `/effort` 菜单移除。

### 2.10 质量模式（pattern 库）

工具规格列出了一组可组合的「质量模式」，这是动态 Workflow 真正的杠杆（不只是「跑更多 agent」）：

| 模式 | 做法 | 解决什么 |
|------|------|----------|
| **Adversarial verify** | 每个发现 spawn N 个独立「怀疑者」，prompt 要求其**反驳**；多数反驳则杀掉 | 防止「看似合理但错误」的发现流出 |
| **Perspective-diverse verify** | 给每个 verifier 不同视角（正确性 / 安全 / 性能 / 能否复现）而非 N 个相同反驳者 | 多样性能抓到冗余抓不到的失败模式 |
| **Judge panel** | 从不同角度生成 N 个独立方案，并行打分，从赢家综合并嫁接亚军的好点子 | 解空间宽时优于「一稿改到底」 |
| **Loop-until-dry** | 未知规模的发现（bug / 边角 case），反复 spawn finder 直到 K 轮无新结果 | 简单计数器（while count<N）会漏掉长尾 |
| **Multi-modal sweep** | 多个 agent 各用不同搜索方式（按容器 / 按内容 / 按实体 / 按时间） | 单一搜索角度找不全时 |
| **Completeness critic** | 最后一个 agent 问「还缺什么——没跑的模态？没验证的断言？没读的源？」 | 它找到的就是下一轮工作 |
| **No silent caps** | 若 workflow 限了覆盖范围（top-N / 不重试 / 采样），用 `log()` 说明丢了什么 | 静默截断会被误读成「全覆盖了」 |

---

## 3. Chorus 的编排模型（对照基线）

为了公平对比，先用本仓库源码精确描述 Chorus 自己的「多 Agent 编排」是怎么运作的。

### 3.1 AI-DLC 业务流水线（编排的「主线」）

Chorus 的编排粒度是**业务生命周期**，不是函数调用：

```
Idea → Proposal →(approve 物化)→ [Document + Task] → Execute → Verify → Done
人创建   PM Agent 起草           PM Agent             Dev Agent   Admin     Admin
```

核心哲学是 **"Reversed Conversation"**：AI 提议，人验证（而非人 prompt → AI 执行）。这与动态 Workflow 的「全自动、跑完才回报」是**相反的人机定位**。

### 3.2 Session / Swarm 机制（`src/services/session.service.ts`）

- `createSession()`（`session.service.ts:114`）建 `AgentSession` 记录，初始 `active`。
- 心跳：`heartbeatSession()`（`:372`）只刷 `lastActiveAt`；过期阈值 `SESSION_STALE_THRESHOLD_MS = 60min`（`:49`），在读取时计算 staleness。
- 生命周期：`active → closed`（`:240`），关闭时在单事务里批量 checkout 所有活跃 task checkin。
- task 绑定：`sessionCheckinToTask()`（`:258`）建 / 复活 `SessionTaskCheckin`，若任务无 assignee 则自动 claim 给该 session 的 agent（`:276-287`）；`sessionCheckoutFromTask()`（`:310`）打 `checkoutAt`。
- **关键**：session 把「agent 可用性」与「任务分配」解耦——一个 session 可并发 check-in 多个任务，多个 session 可同时活跃在同一项目（worker 按 session UUID 去重，`:459-556`）。

> 这是 Chorus 对「sub-agent 集群（swarm）」的可观测性方案：当 Claude Code Agent Teams spawn 子 agent 时，每个子 agent 对应一个 Session，平台据此知道「哪个 worker 在哪个任务上」。

### 3.3 任务依赖 DAG（`src/services/task.service.ts`）

- 存储：`TaskDependency` 表，唯一复合键 `[taskUuid, dependsOnUuid]`，存有向边。
- 环检测：`wouldCreateCycle()`（`:971-1010`）从 `dependsOnUuid` 出发 DFS，若可达 `startUuid` 则成环，阻断 `addTaskDependency()`（`:1039`）。
- 就绪计算：`getUnblockedTasks()`（`:1092-1153`）取状态在 `["open","assigned"]` 且**不存在任一依赖其状态不在 `["done","closed"]`** 的任务。**注意 `to_verify` 不算「已解决」——只有 `done`/`closed` 才解锁下游。**
- 物化：Proposal 批准时（`:720-735`）把 task draft 的 `dependsOnDraftUuids` 映射成真实 task UUID 后批量建边。

### 3.4 Proposal → 物化（`src/services/proposal.service.ts:625-775`）

Proposal 是**容器**，持有 `documentDrafts`（JSON）和 `taskDrafts`（JSON）。批准是**单个原子事务**（15s 超时，`:760`）：更新状态 → 批量建 Document → 批量建 Task → 映射 draft UUID 到真实 UUID → 批量建依赖边 → 批量建验收标准。要么全物化要么全不物化。

### 3.5 Activity Stream（`src/services/activity.service.ts`）

- `Activity` 表含 `actorType/actorUuid/action/value/targetType/targetUuid`，外加可选 `sessionUuid` + `sessionName`（`:29-30, :139-140`）。
- `sessionName` 在创建时去规范化（denormalize）写入，便于 UI 不 join 就显示「Sub-Agent-X（via Session-Y）完成 Task-Z」。
- `createActivity()`（`:117-159`）写库后立即发事件总线，做实时同步。

### 3.6 验收标准 + 验证（`src/services/task.service.ts:719-904`）

- `AcceptanceCriterion` 独立成表，**双轨验证**：开发自检（`devStatus/devEvidence/...`）+ Admin 验证（`status/evidence/...`）。
- `reportCriteriaSelfCheck()`（`:784`）开发期自检；`markAcceptanceCriteria()`（`:744`）Admin 终判。
- 闸门：`checkAcceptanceCriteriaGate()`（`:871-904`）阻断 `to_verify → done`，除非所有 `required` 标准 `status === "passed"`。
- 回退重置：任务从 `to_verify` 退回非 `done` 状态时，所有 AC 字段重置（`:539-558`）。

### 3.7 `/yolo`：Chorus 现有的「全自动编排」

`/yolo` skill 已经实现了一条全自动流水线，且**已经有对抗式验证和收敛循环的雏形**：

- **Phase 2 Proposal Review Loop**：submit 后 spawn `chorus:proposal-reviewer` 子 agent，读 VERDICT（PASS / PASS WITH NOTES / FAIL），FAIL 则改稿重提，最多 `maxProposalReviewRounds`（默认 3）轮。
- **Phase 3 Wave 执行**：`chorus_get_unblocked_tasks` 找就绪任务 → `TeamCreate` → 每个任务 spawn 一个 Agent → 等全部完成 → 进入验证 → 下一 wave。**这是一个「barrier 式的分波并行」**。
- **Phase 4 验证**：每个任务 spawn `chorus:task-reviewer`，读 VERDICT，PASS 则 `mark_acceptance_criteria` + `admin_verify_task`（解锁下游），FAIL 则 `admin_reopen_task` 回炉，最多 `maxTaskReviewRounds`（默认 3）轮。

**这正是关键对照点**：`/yolo` 是「用自然语言 skill 指挥模型逐轮编排 subagent」——而动态 Workflow 的全部设计动机，就是要取代这种「模型逐轮决策 + 结果回灌主上下文」的模式。

---

## 4. 逐维度对比

| 维度 | Claude Code 动态 Workflow | Chorus |
|------|---------------------------|--------|
| **编排粒度** | 函数调用级 subagent 调度（`agent()`/`parallel()`/`pipeline()`） | 业务生命周期级（Idea→Proposal→Task→Verify） |
| **编排载体** | 模型即时生成的 JS 脚本（确定性控制流） | 服务层代码 + skill（自然语言流程）+ 数据库状态机 |
| **确定性 vs 自治** | 控制流**确定性**（循环/分支写死在脚本），agent 只负责「思考」 | 流程由 skill 描述、模型逐轮决策（自治度高，确定性低） |
| **状态存储** | 脚本内存变量（瞬态） | PostgreSQL（持久化、21 张表） |
| **作用域 / 时间跨度** | 单会话、单次运行、跑完即弃 | 跨会话、跨 Agent、跨人，长期存活 |
| **人机定位** | 全自动，跑完才回报（"check before it reaches you"） | Reversed Conversation：AI 提议、**人验证**，处处可介入 |
| **并行规模** | 几十到上百并行（runtime cap `min(16, cores-2)`，总数 ≤1000） | 受 Agent Teams 与 wave 设计约束，量级更小 |
| **对抗式验证** | 一等公民（adversarial verify / 多视角 / judge panel 内建模式） | 已有雏形：proposal-reviewer / task-reviewer（自然语言 VERDICT 循环） |
| **收敛机制** | loop-until-dry / 收敛驱动迭代（实时决定轮数） | 固定 max rounds（`maxProposalReviewRounds`/`maxTaskReviewRounds` 默认 3） |
| **结构化输出** | `schema` 强制 + 工具层校验 + 自动重试 | 工具入参有 zod schema；reviewer 结论靠文本 `VERDICT:` 约定解析 |
| **预算控制** | `budget` 对象，硬上限，到顶抛错 | 无内建 token 预算；靠 max rounds 间接控成本 |
| **断点续跑** | runId + journal，同会话内缓存未改动前缀 | 天然「续跑」：所有实体落库，Ctrl+C 后可 `/develop`/`/review` 接力 |
| **隔离** | 可选 worktree（并行改文件防冲突） | Session 级隔离 + 多租户 companyUuid 边界 |
| **可观测性** | `/workflows` 看实时进度树（瞬态） | Activity Stream + Session + Web UI（持久审计轨迹） |
| **可复用性** | 脚本可保存、命名、复跑（`scriptPath`/named workflow） | Proposal/Document/Task 模板化弱，但流程 skill 可复用 |

**一句话总结对比**：动态 Workflow 在「单次大任务的执行效率与结果可信度」上极强（确定性编排 + 对抗验证 + 收敛）；Chorus 在「跨会话/跨主体的持久协作、人在环路治理、可审计性」上极强。**两者的强项几乎正交。**

---

## 5. 对 Chorus 有没有直接启发？—— 有，而且很具体

结论：**有直接启发，但不是「用动态 Workflow 替换 Chorus」，而是「把动态 Workflow 的编排模式注入 Chorus 的执行阶段」。**

三个层面的启发：

### 5.1 模式层（pattern）—— 立刻可借鉴，零依赖

这些是纯设计思想，不依赖 Claude Code runtime，Chorus 的 skill / 服务层就能落地：

1. **pipeline 优先于 barrier**：`/yolo` 现在的 Phase 3 是「整 wave 跑完才进 Phase 4 验证」（barrier）。改成**流水线**——某个任务一进 `to_verify` 就立刻 spawn task-reviewer 验证，不等同 wave 的其它任务。这能显著缩短墙钟时间（对照 2.3 的气味测试）。

2. **多视角对抗验证**：现在 task-reviewer 是单一 reviewer。借鉴「perspective-diverse verify」——对关键任务并行跑「正确性 / 安全 / AC 覆盖度」三个视角的 reviewer，多数通过才 verify。Chorus 已有 reviewer 基础设施，扩展成本低。

3. **loop-until-dry 替代固定 max rounds**：现在固定 3 轮。对「bug 清扫 / 验收漏洞」类任务，改成「连续 K 轮无新 BLOCKER 才收敛」更贴合真实需要（动态 Workflow 的核心洞见之一）。

4. **结构化 VERDICT**：reviewer 现在靠文本 `VERDICT:` 约定。借鉴 `schema` 思想——让 reviewer 返回结构化 JSON（`{verdict, blockers[], acEvidence[]}`），减少解析歧义。Chorus 工具入参已用 zod，可顺势给 reviewer 输出也加 schema 约定。

5. **No silent caps（不静默截断）**：与 Chorus 已有的「[No silent errors]」记忆一致——任何跳过的任务 / 截断的覆盖都要在 Activity 或报告里显式记录。

### 5.2 集成层（integration）—— 中期，价值最大

**把动态 Workflow 作为 Chorus 任务执行阶段的「可选执行后端」。**

设想：当用户在 Claude Code 里用 Chorus 插件跑 `/yolo`，且本地 Claude Code 支持动态 Workflow（v2.1.154+）时，Phase 3+4 不再用「自然语言 skill 逐轮指挥 + Agent Teams」，而是**生成一段 workflow 脚本**：

```js
// 伪代码：Chorus 任务执行 workflow
export const meta = { name: 'chorus-execute-proposal', description: '...', phases: [{title:'Execute'},{title:'Verify'}] }
let dry = 0
while (dry < 2) {
  const unblocked = /* chorus_get_unblocked_tasks via MCP */
  if (!unblocked.length) break
  await pipeline(unblocked,
    t => agent(`实现 Chorus 任务 ${t.uuid}，遵循 /develop`, { phase: 'Execute' }),
    (_, t) => parallel(['correctness','ac-coverage','security'].map(lens => () =>
      agent(`以 ${lens} 视角审 task ${t.uuid}，返回 VERDICT`, { phase: 'Verify', schema: VERDICT })))
      .then(verdicts => /* 多数 PASS → chorus_admin_verify_task；否则 reopen */))
}
```

收益：
- **省 token**：中间结果（每个任务的实现细节、reviewer 推理）留在脚本变量，不回灌主会话上下文——这正是动态 Workflow 相对 `/yolo` 现状的核心优势。
- **更可靠**：确定性控制流 + 内建对抗验证 + 收敛，比「模型每轮自己决定下一步」更稳。
- **可复跑**：workflow 脚本可保存复用；断点续跑天然契合 Chorus「所有实体落库」的特性。

> 关键约束：动态 Workflow 是**单会话瞬态**的，Chorus 是**跨会话持久**的。集成时要让 workflow 脚本通过 MCP 工具（`chorus_*`）把每一步**落库**到 Chorus，这样即便 workflow 跑完即弃，Chorus 里仍留有完整审计轨迹和可接力状态。两者的「续跑」语义要对齐：workflow 的 journal 是会话内的，Chorus 的「续跑」是数据库级的——后者是更强的持久化保证。

### 5.3 哲学层（philosophy）—— 长期定位

动态 Workflow 证明了一件事：**「确定性编排 + LLM 思考 + 对抗式验证」是大任务的正确形态**，而「模型逐轮自由决策」在大规模下既贵又不稳。

这对 Chorus 的长期定位是利好而非威胁：
- Chorus 的差异化护城河是 **Reversed Conversation + 持久化人机协作治理**，这是动态 Workflow（全自动、瞬态）**不做也不想做**的事。
- Chorus 应把动态 Workflow 当作**执行层的一个加速器 / 后端选项**，而非平台替代。平台的价值在「跨主体协作、人在环路、可审计」，执行引擎可以换。

---

## 6. 可执行建议清单（可直接转成 Proposal）

以下 6 条按「价值 / 成本」排序，每条都标注了影响的 Chorus 模块，便于直接起草 Proposal 的 task drafts。

| # | 建议 | 影响模块 | 成本 | 价值 |
|---|------|----------|------|------|
| **R1** | **`/yolo` Phase 3+4 改 pipeline 语义**：任务一进 `to_verify` 立刻验证，不等整 wave | `skills/yolo/SKILL.md` | 低（改 skill 文档 + 编排逻辑） | 高（缩短墙钟、更贴近动态 Workflow 范式） |
| **R2** | **reviewer 输出结构化**：proposal-reviewer / task-reviewer 返回 `{verdict, blockers[], evidence[]}` JSON，而非纯文本 `VERDICT:` | `chorus:proposal-reviewer`、`chorus:task-reviewer` agent 定义 | 低 | 中（减少解析歧义、便于自动决策） |
| **R3** | **多视角对抗验证**：对关键任务并行跑「正确性 / AC 覆盖 / 安全」多 reviewer，多数通过才 verify | yolo Phase 4、review skill | 中 | 高（抓单 reviewer 漏掉的失败模式） |
| **R4** | **loop-until-dry 收敛选项**：把固定 `maxRounds` 改为「连续 K 轮无新 BLOCKER 即收敛」的可选模式 | yolo 配置、reviewer 循环 | 中 | 中（更贴合 bug 清扫类任务） |
| **R5** | **动态 Workflow 执行后端（探索性 spike）**：调研把 `/yolo` 执行阶段生成为一段 workflow 脚本、中间态不回灌主上下文的可行性与 token 收益 | 新增 `docs/` 设计 + 插件层 | 高 | 高（核心 token / 可靠性收益，但依赖 CC v2.1.154+） |
| **R6** | **No silent caps 落库**：workflow / yolo 中任何跳过的任务、截断的覆盖，都写入 Activity Stream | `activity.service.ts`、yolo 报告 | 低 | 中（与现有「no silent errors」原则一致，强化可审计性） |

> 建议先做 **R1 + R2 + R6**（低成本、立竿见影、不依赖外部能力），R3/R4 作为第二批，R5 作为单独的探索性 spike（需先确认目标环境 Claude Code 版本与动态 Workflow 可用性）。

---

## 7. 风险与注意事项

1. **研究预览状态**：动态 Workflow 仍是 research preview，API / 行为可能变动；R5 的集成方案要做好「能力探测 + 优雅降级到现有 Agent Teams 路径」（与 `/yolo` 现有的「TeamCreate 失败则 fallback 主 agent」一致的思路）。
2. **版本门槛**：需 Claude Code v2.1.154+ 且对应计划（Max/Team/Enterprise）开启；不能假设所有 Chorus 用户都具备。
3. **瞬态 vs 持久语义错配**：workflow 的会话内 journal **不是** Chorus 的数据库级续跑——集成时必须让脚本通过 MCP 把状态落库，否则会话退出后 workflow 进度丢失，与 Chorus「Ctrl+C 后可接力」的承诺冲突。
4. **成本可观测**：动态 Workflow 可 spawn 上百 agent，token 消耗大。即便集成，也要保留 Chorus 侧的 max rounds / 预算护栏，避免失控。
5. **不要本末倒置**：动态 Workflow 是执行加速器，**不是** Chorus 的人机协作治理模型的替代。保持 Reversed Conversation 与持久审计这两条护城河。

---

## 参考来源

权威源：本会话挂载的 `Workflow` 工具完整规格（含 `meta`、`agent/parallel/pipeline/phase/log/workflow` 原语、并发上限、budget、worktree、resume/journal、质量模式库）。

公开交叉验证：
- Claude Code Docs — *Orchestrate subagents at scale with dynamic workflows*：https://code.claude.com/docs/en/workflows
- Claude Code Docs — *Run agents in parallel*：https://code.claude.com/docs/en/agents
- Anthropic — *Introducing Claude Opus 4.8*（动态 Workflow release note）：https://www.anthropic.com/news/claude-opus-4-8
- alexop.dev — *Claude Code Workflows: Deterministic Multi-Agent Orchestration*
- claudefa.st — *Dynamic Workflows in Claude Code: Complete Guide 2026*
- marktechpost — *Anthropic Ships Claude Opus 4.8 Alongside Dynamic Workflows*（v2.1.154、1000 subagent 上限、触发方式）
- kenhuangus.substack.com — *Claude Code Orchestration: Dynamic Workflows / Subagents / Agent Teams*

Chorus 侧（本仓库源码）：
- `src/services/session.service.ts`、`src/services/task.service.ts`、`src/services/proposal.service.ts`、`src/services/activity.service.ts`
- `skills/yolo/SKILL.md`（Chorus 插件 0.9.0）、`CLAUDE.md`、`docs/MCP_TOOLS.md`
