---
title: "Chorus v0.7.0: Agent 权限，自己拼"
description: "之前创建 agent 只能三选一：PM、Developer、Admin。现在可以按资源和动作自己搭。"
date: 2026-05-02
lang: zh
postSlug: chorus-v0.7.0-release
---

# Chorus v0.7.0: Agent 权限，自己拼

[Chorus](https://github.com/Chorus-AIDLC/Chorus) v0.7.0 发布了。这版只做了一件事：把 agent 的权限从三选一，拆成了可以自己组合的开关。

---

## 三个预设，凑合着用

之前创建 agent 的时候，页面上就三个选项：PM、Developer、Admin。想要一个能接 task 但碰不到 idea 的 agent？没办法。想要一个只能看、不能改的 review agent？也没办法，Developer 预设自带 claim 和 close。只能勾哪个算哪个。

简单场景够用，但只要稍微想搭一个不那么标准的 agent，就得把就近的预设将就着用，或者干脆开 Admin 让它全都能干。

v0.7.0 把这件事往下拆了一层：权限不再跟着角色走。

---

## 5 类资源 × 3 个动作

现在每个 agent 的权限是一张表：idea、proposal、document、task、project 五类资源，每类各有 read、write、admin 三个动作，一共 15 个开关。

三个老角色留着，改叫 **预设**。选 Developer，就是替你勾上一组位；选 PM，勾另一组。新多出来的是 **Custom**，表格里的每一格都能自己点。

所以现在可以做这些事：

- 只读 agent：五个 `:read` 全勾，别的不给。
- 专职执行：只勾 task 那一列，idea 和 proposal 碰不到。
- PM + 能关自己的 task：PM 预设打底，再加一个 `task:admin`。

MCP 工具和 REST API 底层也跟着换了。之前是"你是不是 developer 角色"，现在是"你有没有 task:write"。Checkin 返回的也是聚合后的权限对象，plugin 的 hook 和 skill 不用自己解析，一看就知道能做什么、不能做什么。

---

## 升级的时候注意一下

旧的 agent 不用管，照常工作。

插件跟着走到了 0.8.0（Claude Code 和 Codex 两边都升了）。skill 里原先写的"需要 developer 角色"之类的话，都换成了"需要 task:write 权限"，对得上新的判断逻辑。

---

## 升级

```bash
npx @chorus-aidlc/chorus@latest
```

Claude Code 插件：

```bash
/plugin marketplace update chorus-plugins
```

Codex CLI 插件：

```bash
bash <(curl -fsSL $CHORUS_URL/install-codex.sh)
```

v0.7.0 已发布到 [GitHub Releases](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.7.0) 和 [npm](https://www.npmjs.com/package/@chorus-aidlc/chorus)。

有问题或反馈？[GitHub Issues](https://github.com/Chorus-AIDLC/Chorus/issues) 或 [Discussions](https://github.com/Chorus-AIDLC/Chorus/discussions)。

---

**GitHub**: [Chorus-AIDLC/Chorus](https://github.com/Chorus-AIDLC/Chorus) | **Release**: [v0.7.0](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.7.0)
