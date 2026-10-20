# Talking Stick

Run Claude Code, Codex, and Grok on the same repo without them overwriting each other. One agent
holds the stick at a time, handoffs carry structured context so the next agent doesn't re-derive it,
and `tt chat` gives you one console to talk to all of them.

**[Jump to the quickstart →](#quickstart)**

![The tt chat console: three agents in one room, delivery marks on each message, and agent status in the footer](docs/images/tt-chat.png)

No daemon, no server. Multi-process-safe via SQLite WAL, liveness-aware, and it works with Claude
Code, Codex CLI, Antigravity (`agy`), Grok Build, and OpenCode out of the box.

## Quickstart

macOS or glibc Linux, arm64 or x64. No Node or Bun required.

### 1. Install

```bash
curl -fsSL https://raw.githubusercontent.com/mostlydev/talking-stick/master/scripts/install.sh | sh
tt install --all
```

The installer downloads the release for your platform, verifies its SHA-256 checksum, and links
`~/.local/bin/tt`.

`tt install` adds the coordination skill to every harness it finds and skips the ones you don't have.
Restart any harness that was already running so it picks the skill up.

### 2. Set up the panes

Split your terminal like the screenshot above: the agents stacked on the left, the console on the
right. Each pane `cd`s into the same repo — that shared directory is what puts them in one room.

| Left column, one pane per agent | Right column |
|---|---|
| `cd ~/myrepo && claude`<br>`cd ~/myrepo && codex`<br>`cd ~/myrepo && grok` | `cd ~/myrepo && tt chat` |

Two agents is enough to start; add more panes on the left as you want them.

In [Herdr](https://herdr.dev), `tt up` does this for you: the pane you run it from becomes the console, and every installed default agent (Claude, Codex, Antigravity) opens in a column beside it. See [Command overview](#command-overview).

### 3. Point each agent at the skill, and nothing else

Give every agent pane the same one-line prompt:

> `Use the /talking-stick $talking-stick skill.`

That's the whole prompt — no task yet. Each agent joins the room and goes idle waiting for you. You'll
see each one appear in the console as it joins, so they don't announce themselves on top of that.

Prefer a plain prompt over harness goal modes such as `/goal`: their automatic continuation keeps
restarting an agent, which works against `tt standby`.

### 4. Give them the work from the console

Start in `tt chat` with the introduction shown in the screenshot:

> `Hey guys. Introduce yourselves.`

Once the agents have joined, give them the task in that same console:

> `Work together to implement OAuth login.`

It reaches every agent in the room, and they coordinate from there. You don't script the turn-taking:
the skill teaches each agent to join, wait, hand off, test, and review.

Driving from the console, rather than typing into each harness, is what keeps the agents in sync —
each joined agent receives the same room message through its supported delivery path. Agents report
their own work rather than forwarding your message to one another. You'll see who holds
the stick in the footer and a delivery mark next to each agent you message.

| You type | What happens |
|---|---|
| `ship it when tests pass` | Goes to the whole room |
| `@codex rebase onto master` | Goes to Codex; `@everyone` addresses every agent that has joined the room |
| `!@claude stop, wrong file` | Steers Claude mid-task, at its next tool step |
| `/rooms` or Ctrl+T | Directory tree of the repository's rooms with live members; Enter opens one |
| `/members` | Pick a member to message or remove (removal asks first) |
| `/roles` | Assign roles, edit definitions/instructions, and set harness defaults (Tab switches scope; Enter applies) |
| Ctrl+V, a dragged-in image, or `/attach <file>` | Adds `[Image #N]` to the draft; agents get the image's path and read it |
| `/who`, `/help` | Members and stick holder; all commands |

Each message header marks every recipient: `…` not delivered yet, `✓` delivered, `!` failed. That's a
delivery receipt, not proof the model acted on it.

## How a session flows

1. **Join.** Each agent runs `tt join` and `tt instructions show`.
2. **Listen.** With no task yet, each agent enters standby — or keeps one `tt wait --park --json`
   running when it can't self-wake. During assigned work it keeps one `tt wait --json` running
   instead, which returns on anything worth acting on: a turn, a message, a join or leave, a handoff.
3. **Take a turn.** When `tt wait` returns `your_turn` with a live `guardian_pid`, that agent may
   edit, build, and test. A background guardian keeps its lease alive. Everyone else stays read-only
   and can still investigate, message, and leave notes.
4. **Hand off.** The holder tests, then runs `tt release` (to the next fair waiter) or
   `tt assign <agent>` (to a specific reviewer). The handoff carries `status`, `next_action`, and
   `artifacts`.
5. **Talk without passing the stick.** `tt msg send` carries questions, review notes, and vetoes
   between turns.
6. **Go idle.** An agent with nothing to do runs `tt standby` and ends its model turn. A directed
   message, assignment, or pending handoff wakes it again.
7. **Finish.** Every participant reviews the result and explicitly agrees. With a console open,
   agents stay in standby instead of leaving, so you can bring them back with a message.

## Waking idle agents

A directed message, or a room message you send from the console, wakes an idle Claude Code or Codex
session natively — no keystrokes typed, no model polling while idle.

| Harness | How it wakes |
|---|---|
| Claude Code | Its inbox socket. A message you send as the operator arrives at the next tool boundary without cancelling the current tool |
| Codex | `codex queue`, with an app-server start attempt for an idle loaded thread |
| Grok Build | Active-turn hooks while a session is running; an idle session needs a live `tt wait` or cmux |
| Antigravity, OpenCode, Gemini | cmux only |

Claude Code and Codex wakes, and Grok's active-turn hooks, carry the message itself in a compact
envelope, so the agent answers from what it received and acknowledges with `tt ack <token> --json`
instead of fetching again. cmux and anything too large to fit fall back to a body-free notice that
tells the agent to pull with `tt wait`. Details in
[Waking idle agents](docs/reference.md#waking-idle-agents).

## Command overview

```text
tt join / tt leave       join or leave the room for this workspace
tt wait                  long-poll for the turn and room events (--park to never auto-claim)
tt standby               park and wake this session later
tt release / tt pass     hand off with structured status and next action
tt assign <agent>        hand off to someone specific
tt take                  claim when the holder is gone or stuck
tt chat                  operator console
tt up --print            preview a Herdr room setup
tt msg send / tt notes   message live processes, or leave durable notes
tt state / tt health     room state and a concise safety check
```

Full flags and semantics: [`docs/reference.md`](docs/reference.md#command-reference).

Inside Herdr, experimental `tt up` starts every verified default launcher whose
executable and Talking Stick skill are installed (Claude, Codex, and Antigravity).
Grok and OpenCode have experimental adapters available through explicit
`--agents`. The invoking pane becomes chat, with
agent panes stacked evenly in a column to its right. Use `--agents claude,codex`
to choose agents, `--print` to preview, `--new-tab` to create a separate tab,
or `--new-workspace` for a separate workspace. Each agent receives the skill
bootstrap prompt and its exact-room join is verified.
Launch progress goes to stderr, including the created tab/workspace destination
and the bounded join wait; JSON results stay on stdout. An explicitly requested
new tab/workspace is shown after startup calls; current-tab splits keep focus.
With `--json`, redirected input/output, or a harness CLI environment, the
result reports chat as ready and prints a `tt chat --in` next step instead of
entering the interactive console.
New tabs/workspaces created for agents get their own chat console even if another
console is in the room. Repeated launches in the current pane open chat there
again without duplicating confirmed agent panes. New tabs/workspaces reuse a
recorded console only after verifying its pane. If agents already exist but
their layout lacks a console,
the command requests inspection instead of creating a separate console-only tab.
Verified members are reused; uncertain launches require inspection and are never
blindly retried. After checking old panes and confirming exited agents, `--forget`
discards this command's launch record without closing panes. `--print --forget`
previews that fresh plan without changing the record. `--timeout 120s` bounds join
observation in addition to each startup timeout. Skills must be installed first;
Codex starts with `--no-daemon` so its tools and hooks retain the new pane's
process identity for join verification. Chat Escape interrupts an active Codex
turn in that pane through Herdr after matching its session and process. Grok
remains unconfirmed when Herdr omits its session identity.
Panes start in the directory you launch from, and every pane is pinned to one room
(`TT_ROOM`, and `tt chat --in` for the console): the room an ordinary `tt join` from there
selects, or the one named with `--in`. A room that does not exist yet is created only after
preflight passes.

## Installing and updating

| Method | Command |
|---|---|
| Standalone binary (recommended) | `curl -fsSL https://raw.githubusercontent.com/mostlydev/talking-stick/master/scripts/install.sh \| sh` |
| A specific version | `… \| sh -s -- --version 0.23.0` |
| From source | `git clone … && npm install && npm link` (needs Node ≥ 22) |

The installer accepts `--bin-dir DIR` (default `~/.local/bin`) and `--install-dir DIR` (default
`~/.local/share/talking-stick`). Each release lives in its own directory under `releases/`, with the
skill files beside the binary; `tt` is a symlink to the current one.

```bash
tt install --all --print   # preview every change without touching anything
tt install claude-code codex   # install into a subset
tt self-update             # reinstall the latest release with the same directories
tt uninstall --all         # remove
```

**Moving from npm.** The npm package (`talking-stick` on npm) is no longer updated after 0.23.0. Run
the installer above. It moves skill links that still point into the npm package over to the new
install (only links Talking Stick made and you have not edited), then offers to run
`npm uninstall -g talking-stick` for you (default No; `--remove-npm` answers yes, and a run with no
terminal just prints the command). It only offers once `~/.local/bin` is on your `PATH`, and never for an
`npm link`ed checkout. Skill links go through `~/.local/share/talking-stick/current`, so later updates
keep them current.

After updating, restart running harnesses so they load the new skill, and reopen `tt chat` so it uses
the new build.

Installing for Claude Code also adds a Stop-guard hook that blocks a session from stopping once while
it still holds the stick, telling it to hand off first. It is read-only, fails open, and never blocks
twice in a row. Skip it with `tt install claude-code --no-guard` (`--no-guard` needs an explicit
harness or `--all`). Grok Build gets the same guard, and keeps its delivery and session hooks either
way.

## Customizing what agents are told

The bundled skill is the safety floor. Your own collaboration preferences live in editable Markdown
that agents read after joining:

```bash
tt instructions show      # effective prompt for the detected harness
tt instructions edit      # your defaults
tt instructions edit --project   # this repo's overrides
```

Layering is bundled defaults → user overrides → project overrides. Unedited generated files update
automatically; customized ones are preserved. See
[Editable collaboration instructions](docs/reference.md#editable-collaboration-instructions).

## Storage

`~/.local/share/talking-stick/rooms.sqlite` on Linux/macOS (honoring `$XDG_DATA_HOME`),
`%APPDATA%\talking-stick\rooms.sqlite` on Windows. Override with `TALKING_STICK_DATA_DIR`.

## Development

```bash
npm install
npm test            # Node/Vitest suite; builds and drives the standalone binary when Bun is installed
npm run test:bun    # bun:sqlite adapter tests (needs Bun)
npm run typecheck
npm run build
node scripts/build-standalone.mjs   # standalone archive for this platform, in release-dist/
```

A development checkout runs `dist/cli.js` under Node (better-sqlite3); the standalone binary is the
same code compiled with `bun build --compile` (bun:sqlite). Run `npm run build` after source changes
and restart any long-running harness that cached the old build.

When cutting a release, add entries under `CHANGELOG.md`'s `Unreleased` section, then run
`npm version <new-version>`. The lifecycle script moves those entries into the new version section,
writes `docs/releases/<version>.md`, and adds the GitHub release link before npm commits and tags.
Pushing the `v<version>` tag runs the Release workflow, which builds and smoke-tests the macOS and
Linux binaries and attaches them, with `checksums.txt`, to the GitHub release.
Write local links relative to the repository root; the script rebases them for the release notes and
aborts before writing anything if a local target is missing. Put code examples in fenced blocks, since
indented lines are treated as list continuations and their links are rewritten too. Keep inline code
spans on one line.

## Read next

- [`docs/reference.md`](docs/reference.md) — full command surface, delivery semantics, identity
  resolution, install behavior, and design notes.
- [`docs/receive-consumer-contract.md`](docs/receive-consumer-contract.md) — cursor ownership,
  subprocess lifecycle, filtering, and authority rules for the unified wait loop.
- [`skills/talking-stick/SKILL.md`](skills/talking-stick/SKILL.md) — the portable skill installed into
  harness skill directories.
- [`CHANGELOG.md`](CHANGELOG.md) — per-version summary; full notes in [`docs/releases/`](docs/releases/).

## License

MIT. See [LICENSE.md](LICENSE.md).
