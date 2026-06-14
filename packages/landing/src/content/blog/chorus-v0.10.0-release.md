---
title: "Chorus v0.10.0: One idea pulls a whole string behind it"
description: "You work on one idea and it spawns three more. The line between them only ever lived in your head."
date: 2026-06-14
lang: en
postSlug: chorus-v0.10.0-release
---

# Chorus v0.10.0: One idea pulls a whole string behind it

Working through one idea tends to pull others out with it. You're talking it over and realize a separate problem deserves its own entry, or a big idea is really three smaller ones. So you create a new idea. The list grows by one, but nothing remembers where it came from.

Run a project for a month or two and you've got a few dozen ideas, all flat in one list. Which one spun off which — that line only lives in your head. Open one again two weeks later and it takes a minute to recall why you created it, or what it split off into.

[Chorus](https://github.com/Chorus-AIDLC/Chorus) v0.10.0 lets ideas connect: an idea can spawn a child, or you can attach an existing idea under another. A parent knows what it pulled out, and that's all it knows. It decides nothing for the ideas below it.

---

## Connected, but nobody's the boss

The easy way to overdo parent/child links is to let the parent run its children: the parent isn't done, so the children are locked; all children finish, so the parent auto-completes; you want to change a child's status, so you have to clear it with the parent first. Jira's epics and sub-tasks, and most issue trackers' parent/child links, work this way. It looks tidy. In practice it's constraints everywhere, and once there are enough of them people stop bothering to link anything at all.

Chorus does the opposite: a parent remembers what it pulled out, and nothing else.

Whether an idea is done depends only on its own proposals and tasks. What it's attached to, how many it spun off, how far those got — none of it matters. The logic that decides an idea's status didn't change a line this release; the link simply doesn't exist as far as it's concerned. All a parent shows is a read-only "+N derived" chip telling you how many it spawned, with a click-through. That's it. Delete a parent and its children don't vanish — the line just breaks and they float back up to the top level.

The link also has no type on purpose. There's no "derived from" versus "contains" distinction, just one unnamed line. Real relationships between ideas are too messy to classify, and forcing a choice means stopping to decide "is this a split-off or a sub-item?" every single time. Stop a few times and you stop linking. So there's no choice to make — what the line means is clear from context.

One parent per idea is the same trade. The whole structure is a forest, not a web. Multiple parents, cross-project attachment, drag-to-reparent — none of that ships yet. A forest is easy to walk, easy to draw, easy to hold in your head. A graph fans out and the reader is lost.

The point: this line is for remembering, not for governing. It keeps track of where an idea came from and what it spun off, and it stays completely out of how any single idea runs.

---

## How you draw the line

Two entry points, two situations.

**Derive.** You're looking at an idea and need to split one out of it. Hit "Derive" on the detail page and the new-idea dialog opens with the current idea pre-filled as the parent. `chorus_pm_create_idea` also takes a `parentUuid` now, so when an agent splits one idea into several during brainstorming or elaboration, it can set the parent right there.

**Attach.** Two ideas already exist and you realize after the fact that one belongs under the other. The Lineage section on the detail page has a set-parent picker — pick one and they're linked. This step checks for cycles: an idea can't be its own parent, and it can't be attached under one of its own descendants, since that would close a loop. The picker grays out any candidate that would form a cycle, and the server checks again — two layers, both catch it.

Both paths run the same service logic, and the MCP side folds into one new tool, `chorus_edit_idea` — title, body, parent, all in one.

---

## The Dashboard is now home for ideas

Once ideas connect, you need somewhere to lay the structure out, and a flat list can't show a tree.

So this release reworked the project Dashboard's Overview. It used to carry two rows of controls, and switching to Stats made the bottom row disappear entirely, so the content jumped up. That's now one three-way switch — Ideas / Lineage / Stats — with New Idea on its own to the right. No more jump.

Which view you land on adapts: if any idea in the project has a parent or has spawned children, you default to the Lineage view; projects with no links still open on the flat status grouping. That's decided once on entry — a newly derived child later won't yank your view out from under you. Pick a view by hand once and that choice is stored per project in localStorage, so the next visit follows you.

The Lineage view isn't a folder tree. It's indented idea rows — each idea is still a full row, with a `↳` marking the derivation and a "+N derived" chip on the parent. Nothing's hidden inside folders; every idea stays in plain sight.

With idea browsing and management fully moved to the Dashboard, the standalone Idea List page was just duplicate work, so it's gone. The old `/projects/:p/ideas` and `/ideas/:id` links still work — they 308-redirect straight to the matching spot on the Dashboard. And the Dashboard header, which used to read a flat "Overview" forever, now shows the project name as the heading with the project description beneath it.

---

## Also in this release

**Fixed: super admin locked out on an email collision.** In local dev it's common to set `SUPER_ADMIN_EMAIL` to the same address as a registered or default user. When that collides, the super admin had no way in: `identify()` returned on the first matching role, and the default-password login form bypassed `identify()` entirely, so `/login/admin` was unreachable. Now `identify()` collects every matching login path on a collision, the login page shows a role picker, and each choice routes to its own original flow. `/login/admin` also accepts a typed email in this up-front picker flow. The auth logic itself is unchanged; en and zh copy both added.

**Three plugins aligned to 0.10.0.** The Claude Code and Codex plugins move to 0.10.0 in lockstep with the main version, and the OpenClaw plugin merges over from its own 0.5.3 line to 0.10.0 as well. All four skill surfaces (Claude Code, Codex, OpenClaw, and the standalone `/skill/` package) gained the derive / attach / read-only-rollup guidance and the `chorus_edit_idea` tool.

---

## Upgrade

```bash
npx @chorus-aidlc/chorus@latest
```

Claude Code plugin:

```bash
/plugin marketplace update chorus-plugins
```

Reinstall the Codex plugin per the release docs.

OpenClaw plugin:

```bash
npm i -g @chorus-aidlc/openclaw-plugin@latest
```

This release ships one DDL migration (a `parentUuid` column and an index on `Idea`), no data migration — run `prisma migrate` once.

v0.10.0 is on [GitHub Releases](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.10.0) and [npm](https://www.npmjs.com/package/@chorus-aidlc/chorus).

Questions or feedback? [GitHub Issues](https://github.com/Chorus-AIDLC/Chorus/issues) or [Discussions](https://github.com/Chorus-AIDLC/Chorus/discussions).

---

**GitHub**: [Chorus-AIDLC/Chorus](https://github.com/Chorus-AIDLC/Chorus) | **Release**: [v0.10.0](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.10.0)
