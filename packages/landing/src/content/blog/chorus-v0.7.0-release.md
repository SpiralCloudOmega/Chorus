---
title: "Chorus v0.7.0: Build Your Own Agent Permissions"
description: "Creating an agent used to be a three-way choice: PM, Developer, or Admin. Now you pick by resource and action."
date: 2026-05-02
lang: en
postSlug: chorus-v0.7.0-release
---

# Chorus v0.7.0: Build Your Own Agent Permissions

[Chorus](https://github.com/Chorus-AIDLC/Chorus) v0.7.0 is out. One thing in this release: agent permissions are no longer a three-way choice. You mix and match them yourself.

---

## Three presets, making do

Before this release, creating an agent gave you three checkboxes: PM, Developer, Admin. Want an agent that can work on tasks but can't touch ideas? Not possible. Want a read-only review agent? Also not possible — the Developer preset comes with claim and close baked in. You picked the preset that was closest, and lived with whatever else it dragged along.

Fine for simple cases. But the moment you want something that doesn't map cleanly onto one of the three boxes, you either settle for the nearest preset or hand the agent Admin and call it a day.

v0.7.0 takes the permissions out of the roles.

---

## 5 resources × 3 actions

An agent's permissions are now a grid: five resources (idea, proposal, document, task, project) and three actions on each (read, write, admin). Fifteen toggles in total.

The three old roles are still there, rebranded as **presets**. Pick Developer and it flips on one set of bits; pick PM and it flips on another. What's new is the **Custom** option — the grid opens up and every cell is clickable.

So now you can do things like:

- Read-only agent: check all five `:read` bits, leave everything else off.
- Task-only worker: only the task column is on — ideas and proposals are off-limits.
- PM who can also close their own tasks: PM preset plus an extra `task:admin`.

Under the hood, the MCP tools and REST API stopped asking "are you a developer role?" and started asking "do you have task:write?". The checkin response now returns permissions pre-aggregated, so plugin hooks and skills don't have to parse roles themselves — they just read what they're allowed to do.

---

## A heads-up for upgraders

Existing agents keep working as-is.

The plugin moved to 0.8.0 too (both Claude Code and Codex). Skill docs that used to say "requires the developer role" now say "requires task:write" — matching the new check underneath.

---

## Upgrade

```bash
npx @chorus-aidlc/chorus@latest
```

Claude Code plugin:

```bash
/plugin marketplace update chorus-plugins
```

Codex CLI plugin:

```bash
bash <(curl -fsSL $CHORUS_URL/install-codex.sh)
```

v0.7.0 is on [GitHub Releases](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.7.0) and [npm](https://www.npmjs.com/package/@chorus-aidlc/chorus).

Questions or feedback? [GitHub Issues](https://github.com/Chorus-AIDLC/Chorus/issues) or [Discussions](https://github.com/Chorus-AIDLC/Chorus/discussions).

---

**GitHub**: [Chorus-AIDLC/Chorus](https://github.com/Chorus-AIDLC/Chorus) | **Release**: [v0.7.0](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.7.0)
