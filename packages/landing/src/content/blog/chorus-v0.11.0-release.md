---
title: "Chorus v0.11.0: You assigned the work — now the agent actually picks it up"
description: "You give an agent permissions, hand it a task, and it sits in a database row waiting for you to open a terminal and wake it. That's your always-on teammate?"
date: 2026-06-21
lang: en
postSlug: chorus-v0.11.0-release
---

# Chorus v0.11.0: You assigned the work — now the agent actually picks it up

You give an agent permissions and hand it a task. It should start working — but it doesn't. The task just sits there. It waits until you open your laptop, start Claude Code, load the skill, and claim it by hand. Until then, the agent is a row in a database.

Tasks aren't the only thing. An idea gets elaborated and someone has to write the proposal. Someone @-mentions your agent in a comment and waits for a reply. All of it needs you at a terminal, waking the agent by hand. Chorus is built on AI proposes, human verifies — but for all the talk of AI and humans working together, the AI half is offline most of the time. It's not an always-on teammate. It's a tool you have to restart by hand every single time.

[Chorus](https://github.com/Chorus-AIDLC/Chorus) v0.11.0 ships `chorus daemon`: it turns your machine into a resident agent runtime. The server dispatches work, the daemon wakes a local Claude Code to do it. You don't sit at the terminal. The work arrives and gets picked up right there.

---

## Start a daemon and it just waits

One command:

```bash
npx @chorus-aidlc/chorus daemon
```

What it does is simple: log in as your agent, subscribe to the server's notification stream, and wait. When an event lands for that agent — a task assigned, an @-mention, an elaboration verified, an instruction you sent — it starts a headless `claude -p` locally, wires it to the Chorus MCP, and lets it work through the `chorus_*` tools.

There's no Agent SDK here, just a child process. The upshot: no new dependencies, cross-platform; the prompt goes over stdin instead of argv; on Windows it finds `claude.cmd` itself. Install the Chorus npm package and it runs.

To keep it resident in the background, add `-d`:

```bash
chorus daemon -d        # background
chorus daemon status    # status
chorus daemon logs      # logs
chorus daemon stop      # stop
```

First run, no credentials configured, on a terminal? It just asks for the server URL and API key, validates them, and saves them to `~/.chorus/daemon.json` so it won't ask again. Off a terminal (systemd, nohup, CI), it errors out cleanly instead of hanging on a prompt nobody can answer.

## One idea, one conversation

A wake isn't a one-off task that forgets everything. The daemon anchors each session on the uuid of the idea it belongs to: work under the same idea wakes the same session and `--resume`s the prior context; different ideas stay in separate sessions. Work with no parent idea — a quick task, a standalone doc — anchors on its own uuid and still gets a continuous session. Behind it, a WakeQueue serializes so the same session is never `--resume`d by two wakes at once.

Anchoring on the idea uuid buys you one more thing: you can take over anytime. Every wake logs a hint:

```
[Chorus] spawning new session <idea-uuid> — take over with: claude --resume <idea-uuid>
```

Run that from the daemon's working directory and you drop straight into the agent's conversation — no transcript hunting for a session id. That's where the safety in letting go comes from: the agent's mid-task and you want the wheel, you jump in, seamless.

## You can see it, and you can cut in

An agent running in the background turns into a black box fast: is it connected, what's it on right now, how far has it gotten — no idea.

This release adds an online-agent pill in the sidebar. Click it to list each online connection's running and queued work; click "View all" for a chat-style two-pane surface — the agent's conversations on the left, the selected conversation's live transcript on the right, updating in real time. Every line the agent says, every action it runs, you see it. Underneath is a connection registry that lives in the database, so two ECS instances see the same picture.

Watching isn't enough. The agent goes sideways, or you think of one more thing to add — you need to cut in. Type into that surface and your instruction runs as the next turn on the session's origin daemon: delivered precisely to the machine that started it, not broadcast to every connection under the agent's name, because only that machine can `--resume`. A running turn can be interrupted too: the server sends a non-wake control event, the daemon kills the headless Claude's process tree (SIGINT first, then take the children with it, no native deps). The interrupt is sticky — it sits there until you hit resume, then `--resume`s and picks up the same conversation.

You can also skip tasks entirely and just open a conversation with your agent. These ad-hoc chats are first-class, same as task runs: visible, interruptible, resumable.

## Letting go is the default

The daemon runs in yolo mode by default: the woken agent has full autonomy — Bash, file writes, any command — under the daemon's API key. That's deliberate. The daemon exists to do the real code-writing work; tying its hands defeats the point. So this release drops the old one-time y/N confirmation and instead warns you loudly in the startup banner, every time, that it's in yolo. To take the leash back, pass `--chorus-only` and the agent is left with the Chorus MCP tools only — no shell, no file edits. Put "letting go" right in front of you, instead of burying it in a confirmation you clicked once and forgot. The caveat stands: run it only in a trusted, sandboxed environment.

---

## A loop you never touched a terminal for

Put the pieces together and Chorus's "AI proposes, human verifies" runs a full lap for the first time without a terminal.

Take elaboration. An idea used to get elaborated and the agent had to call the MCP tools itself to verify and move on to writing the proposal. Now there's a "Verify Elaborate" button on the idea detail page. A human clicks it, the idea's elaboration is settled, and the agent assigned to that idea is woken — to write the proposal, not to answer another round of questions, but to start writing.

Human clicks verify, AI throws the next round back. Back and forth, and you never opened a terminal. That's what "reversed conversation" was supposed to feel like: not human prompts, AI executes — but AI proposes, human confirms, AI takes the next step.

## Where the industry's already headed

Getting agents off the terminal and running unattended is where the whole industry has gone this year. Claude Code's headless `-p` mode, the Agent SDK, background agents of every kind — Anthropic keeps pushing one thing: an agent shouldn't need a person sitting at a terminal. Chorus isn't inventing a new workflow. It's making the one you already use — ideas, proposals, tasks, verification — the place where an assigned agent is actually resident and actually moving.

That's why the OpenClaw plugin caught up this release too: it now speaks the exact same bidirectional daemon protocol as the `chorus` CLI, just remapped onto its own in-process `runEmbeddedAgent`. Same reverse control channel, execution-state reporting, streaming transcript relay, real mid-run interrupts. The server didn't change a line — both runtimes talk to the same interface.

Back to where we started. You assigned the work, and now the agent picks it up. That offline half of your AI is finally online, and you don't have to sit at a terminal waking it out of a database row by hand.

---

## Also in this release

**Fixed: the Dashboard idea panel didn't sync on soft navigation.** Clicking an idea link from a notification, an SSE toast, or global search changed the address bar but never opened or switched the panel on the right — the hook only re-synced on popstate, and Next.js soft navigation changes the URL without firing one. It now derives the selection straight from `useSearchParams()`.

**The daemon chat modal now goes full-screen on mobile** with the input pinned to the bottom, and wide markdown blocks (tables, code, long links) are contained inside the transcript instead of overflowing sideways. Each agent candidate in the @-mention dropdown now carries presence — a green dot plus an "N active" or "Idle" line — so you know if it's around and busy before you @ it.

**Three plugins aligned to 0.11.0.** The Claude Code, Codex, and OpenClaw packages, plus the standalone `/skill/` distribution, all move to 0.11.0 together.

---

## Upgrade

```bash
npx @chorus-aidlc/chorus@latest
```

Start a daemon (Claude Code is the only local agent backend for now):

```bash
npx @chorus-aidlc/chorus daemon
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

This release ships a few DDL migrations (the daemon connection, execution-state, session, and turn tables), no data migration — run `prisma migrate` once.

v0.11.0 is on [GitHub Releases](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.11.0) and [npm](https://www.npmjs.com/package/@chorus-aidlc/chorus).

Questions or feedback? [GitHub Issues](https://github.com/Chorus-AIDLC/Chorus/issues) or [Discussions](https://github.com/Chorus-AIDLC/Chorus/discussions).

---

**GitHub**: [Chorus-AIDLC/Chorus](https://github.com/Chorus-AIDLC/Chorus) | **Release**: [v0.11.0](https://github.com/Chorus-AIDLC/Chorus/releases/tag/v0.11.0)
