# The Eridani link (stages B to E)

remotea-server can keep one outbound WebSocket to Eridani. In stage B the link
is **read-only**: it reports what agents in remotea terminals are doing (state,
finished turns, exits) and runs the session collector in **parity mode**.
Stage C adds the commands Eridani may send (start an agent in a worktree, type
into it, stop it, answer its question, run a configured verification) and
SessionStart context; see [Stage C](#stage-c-dispatch) below. Stage E makes the
collector authoritative and retires the Python one; see
[Collector cutover](#stage-e-collector-cutover).

The design is in `docs/remotea/plan.md` and the mission-control plan (v2,
"Unified link protocol"). The code is:

| Path | Role |
|---|---|
| `src/shared/eridani-link-protocol.ts` | Wire types, guards, limits, digest canonicalization, chunking. Pure. |
| `remote-server/src/eridani-link.ts` | The client: connection state machine (the app's `connection-fsm.ts`), hello/welcome, heartbeat, delivery, inbound journal, status file. |
| `remote-server/src/eridani-spool.ts` | The outbox (`eridani-outbox.jsonl`). |
| `remote-server/src/eridani-journal.ts` | Inbound operations by `op_id` (`eridani-journal.jsonl`). |
| `remote-server/src/eridani-runtime.ts` | Wires link + collector into the server, follows the config files. |
| `remote-server/src/agent-state.ts` | Server-side working / needs_you / idle / exited, with the app's own rules (`src/shared/agent-hook-rules.ts`). |
| `remote-server/src/turn-capture.ts` | One `turn` per root provider turn, from the Stop hook. |
| `remote-server/src/collector/` | TypeScript port of `collector.py`. |
| `remote-server/src/eridani-cli.ts` | `remotea eridani …`. |
| `remote-server/src/dispatch.ts` | Stage C: what each command does; recovery on boot and after a reconnect. |
| `remote-server/src/eridani-targets.ts` | Execution targets in `eridani.json`. |
| `remote-server/src/worktrees.ts` | One worktree per branch; the nominate-only cleanup report. |
| `remote-server/src/questions-claude.ts` | Holding Claude's AskUserQuestion for Eridani. |
| `remote-server/src/context.ts` | SessionStart context from Eridani. |
| `remote-server/src/verify-runner.ts` | One configured verification, with a workspace fingerprint. |

## Configuration

Both files live in the server's config dir (`~/.config/remotea`, or
`$REMOTEA_CONFIG_DIR`).

`eridani.json`:

```json
{ "enabled": true, "url": "wss://eridani.example/api/v1/external/agents/link", "machine": "DavisPC", "collector": "parity" }
```

- `machine` (optional) is the name reports carry; it defaults to the hostname.
- `collector` is `"parity"` (default), `"authoritative"` (stage E, see
  [Collector cutover](#stage-e-collector-cutover)) or `"off"`. Anything else
  reads as `"parity"`.

`eridani-token` holds the link key (`eri_bot_…`), mode 0600. The key is sent
only in the `Authorization` header. It is never logged, never written to the
outbox or the status file, and never put in a session's environment.

The server checks both files' mtime and size every 30 s and starts, restarts or
stops the link to match. Nothing needs a service restart.

## CLI

```
remotea eridani connect [--url <wss://…>] [--machine <name>] [--no-probe]
remotea eridani status [--json]
remotea eridani disconnect [--forget]
remotea eridani collect [--dry-run] [--days N]
remotea eridani collector [parity|authoritative]
```

- `connect` asks for the key without echoing it (or reads it from stdin when
  piped), checks it starts with `eri_bot_`, and proves it with one
  hello → welcome before writing anything. Then it writes the key (0600) and
  enables the link.
- `status` reads `eridani-status.json`, which the running server rewrites at
  most once a second. `state` is `disabled`, `stopped` (enabled but no server is
  running it), or the link's state (`connecting`, `ready`, `reconnecting`,
  `auth-failed`).
- `disconnect` disables the link; `--forget` deletes the key too.
- `collect --dry-run` prints what the collector would report, in the same table
  as `collector.py --dry-run`. Without `--dry-run`, it asks the running server
  to scan now (picked up within 30 s).
- `collector` with no argument prints the mode; with one, switches it (the
  rest of `eridani.json` is kept) and prints the cutover checklist or the
  rollback steps. The server follows within 30 s.

`remotea status --json` gains, additively (`version` stays 1 until the collector cutover, which makes it 2: see [Collector cutover](#stage-e-collector-cutover)):
`sessions[].agentState`, `sessions[].incarnation`, `sessions[].turnSeq`, and
`server.eridani {enabled, state, unacked, lastAckAt}`.

## Connection

- Outbound `ws`/`wss`, subprotocol `eridani.v1`, headers
  `Authorization: Bearer <key>` and `User-Agent: remotea-server/<version>`
  (Cloudflare refuses library default agents). No `Origin`.
- 401/403 at upgrade, or close code 4401/4403: `auth-failed`, next try in
  5 minutes. Anything else: backoff 250 ms · 2ⁿ up to 15 s, with jitter.
- WebSocket ping every 15 s. 25 s with no frame and no pong is a dead link.
- No welcome within 10 s of hello: reconnect.

## Protocol subset (stage B)

Every frame is a JSON text message with the envelope
`{v: 1, id, conn_epoch, t, at}`:

- `id` is new for every send, including a resend.
- `conn_epoch` is `null` on hello, then the integer from welcome.
- `at` is epoch milliseconds, like every timestamp in this protocol.

Effectful frames also carry `op_id` (stable across resends) and `digest`:
sha256 hex of the canonical JSON of the frame minus `v, id, conn_epoch, at,
op_id, digest`. Canonical JSON means keys sorted at every level and no
whitespace, which matches Python's
`json.dumps(x, sort_keys=True, separators=(",", ":"), ensure_ascii=False)` for
the values these frames carry. Integers only: there are no floats in these
frames.

remotea sends:

| `t` | Lane | Coalesced by | Notes |
|---|---|---|---|
| `hello` | | | `server_id, boot_id, hostname, machine, proto: 1, version, caps, harnesses` |
| `sessions.snapshot` | control | (per connection) | Sent after every welcome. `part {of, i, n}`, `surfaces[]`, `journal {pending, uncertain}`. Never persisted. |
| `command.outcome` | control | `outcome:<op_id>` | Stage B only reports `rejected` (`unsupported` / `expired`). |
| `status` | live | `status:<surf>`, numeric `revision` | `surf, incarnation, state, since, reason?, provider?, provider_session_id?` |
| `turn` | live | never | `surf, incarnation, run_id: null, generation: 0, provider, tool, provider_session_id, provider_turn_id, root: true, seq, text, truncated, missing, source, prompt?, prompt_truncated?, ended_at` |
| `exit` | live | never | `surf, incarnation, code, exited_at` |
| `session.report` | bulk | `<tool>:<session_id>`, `revision` = fingerprint | `parity, tool, session_id, report` (the HTTP collector's `SessionInput`, unchanged) |
| `ack` | | | For inbound commands. |
| `bye` | | | On disable or shutdown. |

`caps` is `session.report, session.report.parity, turn, status, exit,
sessions.snapshot, chunking, journal`. `harnesses` is
`{claude|codex: {version, observe, capture, question: false, context: false, resume}}`.

Eridani sends:

- `welcome {host_id, conn_epoch, server_time, replay_horizon?}`
- `ack {acked_id, op_id?, ok, error?, retry?}`. `acked_id` names the
  envelope `id` being acknowledged. `ok:false` with `retry:true` means
  "send it again later" (after 30 s). `ok:false` without it is a permanent
  refusal: the event is dropped and counted in `status.rejected`.
- `bye {reason}`
- Any other `t` with an `op_id` is a command. In stage B every command is
  journaled, acked, and answered with `command.outcome` `rejected` /
  `unsupported`. A repeated `op_id` with the same digest gets the recorded
  outcome again. A repeated `op_id` with a different digest gets
  `ack ok:false error:"DIGEST_MISMATCH"`.

## Delivery and the outbox

- Each event is appended to `eridani-outbox.jsonl` (0600, fdatasync) before it
  is sent, and is removed only when Eridani acks it.
- Every reconnect sends each unacked event once more, with the same `op_id`
  and a new envelope `id`.
- At most 32 events are in flight.
- Lanes go out in order: control, then live, then bulk.
- `status` and `session.report` coalesce per entity. A newer revision replaces
  an unsent older one, and a numeric revision never goes backwards.
- Soft bound: 5,000 entries or 32 MiB. Over it, the oldest coalescable entry
  (bulk first) is evicted and its entity is marked dirty. The collector forgets
  that source's fingerprint and sends it again.
- `turn` and `exit` are never evicted. Past twice the bound they are refused,
  and the status shows `degraded: spool-full`.
- A torn final line from a crash is cut off at load. A failed write
  (ENOSPC, EIO, …) keeps events in memory and marks `degraded: disk-full`.
  The next successful compaction clears it.

## Turn capture

The hook helper (`resources/cli/wmux-hook.js`) forwards these on `Stop`, and
only to a remotea server's bridge, never to a local wmux:

- `last_assistant_message` (cut at 16,000 code points, flagged)
- Codex's `turn_id` and `transcript_path`

The server then applies these rules:

- **Identity.** Codex uses its `turn_id`. Claude uses
  `<session_id>:<surf>:<n>`, where `n` counts `UserPromptSubmit`s in that
  conversation on that surface. A second Stop for the same turn is dropped.
  The cursor is in the registry, so a restart neither repeats nor skips a turn.
- **Root only.** A Stop with `agent_id` (inside a subagent) and `SubagentStop`
  never make a turn.
- **Missing text.** `missing: true` with empty text. Codex then falls back to
  the rollout tail (`agent_message`, `phase: "final_answer"`, same turn id).
  Claude has no fallback: transcripts are not read.
- **Redaction.** Text and prompt go through the collector's redaction before
  anything is stored or sent.
- **Apps.** They still get the `Stop` event, without the server-only fields.

## Agent state

The rules are the app's own, lifted into `src/shared/agent-hook-rules.ts`:

- Background tools and subagents never clear a parent's open question.
- The idle reminder does not count as a question.
- Hook processes are ordered by when they fired.
- Only input typed in an app can clear a question, and a lone Escape ends a run.

The state is `working`, `needs_you`, `idle` or `exited`. It is stored on the
registry record (`agentState`), broadcast to apps as `meta.agentState`, and sent
up as `status`. `since` changes only on a real transition.

`incarnation` goes up each time a lost session is respawned. `turnSeq` and the
turn cursor carry over to the new incarnation.

## Parity procedure

The Python collector stays authoritative during stage B. To compare:

1. Leave the Python collector and its hooks exactly as they are.
2. `remotea eridani connect --url …`. The server's collector sends every
   report with `parity: true`. Eridani compares each one with what it has,
   field by field, and stores nothing.
3. Check the comparison on the Eridani side. Locally,
   `remotea eridani collect --dry-run` and `collector.py --dry-run` print the
   same table for the same sources.
4. Only after the parity report has been clean for long enough is the
   collector switched to authoritative and the Python one retired: see
   [Collector cutover](#stage-e-collector-cutover).

The collector scans when the link becomes ready and every 2 minutes. It also
rescans one conversation right after each of its turns. Scans are skipped
while the outbox is over 80% full.

A source's fingerprint is recorded (`eridani-collector.json`) only when
Eridani acks the report that carried it.

## Stage C: dispatch

### Execution targets

Eridani can only start work where `eridani.json` says it may:

```json
"targets": [{
  "id": "remotea",
  "repo": "/home/davin/remotea/remotea",
  "worktreeRoot": "/home/davin/remotea/worktrees",
  "base": "main",
  "launch": { "claude": {}, "codex": { "bin": "/home/davin/.local/bin/codex" } },
  "verify": [{ "id": "test", "argv": ["npm", "test"], "cwd": "remote-server", "timeout": 600 }]
}]
```

```
remotea eridani targets list [--json]
remotea eridani targets add --id <id> --repo <path> --worktree-root <path> [--base main] [--claude] [--codex] [--verify <id>=<command>]… [--verify-timeout <s>]
remotea eridani targets add --json '<target>'
remotea eridani targets remove <id>
remotea eridani worktrees [--json]
```

Targets are read on every use: adding one needs no restart and does not
reconnect the link. `hello` lists them (`targets: [{id, repo, worktree_root,
harnesses, verify}]`, never argv or env) for Eridani's target picker.

**Trust boundary.** Nothing Eridani sends becomes a program, a path or a shell
word, apart from three validated values: the model name
(`MODEL_RE`: letters, digits and `._:/@[]-`, at most 80), the branch (git ref rules), and the
prompt. The prompt is passed in `$ERIDANI_PROMPT` and expanded by the login
shell as **one argv word**; it is never parsed as shell text, and a prompt
starting with `-` is refused. `env` accepts only `ERIDANI_*` keys with
one-line values. This is policy against Eridani's text becoming commands. It
is not a sandbox: the agent itself runs with `--permission-mode auto` as you.

### Worktrees

One worktree per branch under the target's `worktreeRoot`
(`eri/task-1` → `<root>/eri--task-1`): reused when it exists, created from the
base otherwise (`git worktree add -b <branch> <path> <base sha>`), and the base
is recorded in `eridani-worktrees.json`. A spawn on the base branch itself is
refused. Operations on one repo run one at a time.

remotea **never removes a worktree**. `remotea eridani worktrees` (and the
`worktrees.report` frame) lists each with why removing it would lose work:
in use by a live session, locked, uncommitted / untracked / ignored files
(an unforced `git worktree remove` deletes ignored files such as `.env`), not
merged into its base, unpushed or no upstream, detached. A row with no reason
is a *candidate*, and the CLI prints the commands a person could run: a
recovery ref first (`refs/remotea/recovery/<branch>`), then
`git worktree remove`.

### Commands

| `t` | Fields | Effect |
|---|---|---|
| `spawn` | `run_id, generation, attempt, harness, model, target {id, repo?, branch, base?}, task_id?, title?, group?, prompt, env?, run_token?, verify? {verify_id, plan_revision}, expires_at` | Ensures the worktree and opens a session in it, device "Eridani", in the named group (default "Eridani"). Claude: `claude --model <m> --permission-mode auto "$ERIDANI_PROMPT"`. Codex: `codex --disable daemon_auto_start -m <m> "$ERIDANI_PROMPT"`. The surface id is derived from `(run_id, generation, attempt)`: the same spawn never starts two processes. |
| `input` | `surf, incarnation, run_id, generation, mode: queue\|steer, text` | `queue` waits until the agent is idle at its prompt **and** the link is up; `steer` advances the binding's generation first, sends Esc, then the text. Typed as a bracketed paste and Enter. Never counts as a person answering. |
| `stop` | `surf, incarnation, run_id, generation, mode: interrupt\|kill` | `stopRequested` is persisted on the session before anything is sent, and cleared only when the exit is seen. `interrupt`: Ctrl-C twice, and again after 1.5 s; if the process is still there after 20 s the outcome is `failed` ("send mode:kill") and the stop stays requested. `kill`: the process tree. A run with a requested stop is never resumed. |
| `answer` | `question_id, provider_request_id, answers [{item_id, choice_ids?, text?}]` | See [Questions](#questions-claude). |
| `verify` | `attempt_id, run_id, generation, turn_seq, plan_revision, verify_id` | Runs one of the target's `verify` entries in the run's worktree (fixed argv, no shell, `CI=1`, the target's timeout), then sends `verify.result`. Shares the attempt machinery of [stage D](#stage-d-verification-after-turns). |

Every command needs a fence that matches: an `input`/`stop` names the surface
and its `incarnation`, the run, and the generation (a queued input must match
the current generation; steer and stop may name a newer one). A command whose
`expires_at` is past, or more than 7 days out (the replay horizon), is
rejected.

**Journal.** For every command: `accepted` is written and fsynced (with the
command body) **before** the ack goes out; `executing` is written when its
effect starts; the outcome is written, then sent as
`command.outcome {command_id: <op_id>, state, kind, detail?, result?}`. The
ack of an accepted command already says
`outcome {state: "accepted", surf, incarnation}` for a spawn. After a restart:

- `accepted` commands are re-checked and run once Eridani's `runs.snapshot`
  has been applied (or 10 s after the link is ready without one);
- `executing` commands are settled without being run again: a `spawn` by
  whether its session exists (`executed` / `failed`), a `stop` as `executed`
  (the process ended with the server), a `verify` as `failed`; an `input` or
  `answer` becomes `uncertain`, since its bytes may or may not have arrived;
- a duplicate `op_id` gets its recorded outcome, never a second run.

**Recovery on boot.** Eridani sessions the restart lost are respawned with
their conversation (`claude --resume <id> --model <m> --permission-mode auto`,
`codex resume --disable daemon_auto_start -m <m> <id>`), with the run's env
from `eridani-runs.json` (0600; the run token and env never go into the
registry). A lost session whose stop was requested is marked exited instead.
This happens whether or not the link is enabled.

**runs.snapshot** (Eridani → remotea, after welcome, chunked like the
snapshot): `runs [{run_id, generation, desired: continue|stop|none,
stop_mode?, verify? {verify_id, plan_revision} | null}]`. A newer generation is adopted (an older queued input is then
refused); `desired: stop` is carried out like a stop command.

### Questions (Claude)

The remotea server installs one synchronous PreToolUse hook matched on
`AskUserQuestion` (timeout 600 s) and one async PostToolUse for it. The app
does not install them. For a session bound to a run, with the link up:

1. the helper holds `remotea.question` on the bridge; the server sends
   `question {question_id, surf, incarnation, run_id, generation,
   provider: "claude", provider_session_id, provider_request_id (tool_use_id),
   provider_turn_id (prompt_id), kind: "ask", group_id, items [{id, text,
   header?, choices [{id, label, description?}], multi?}], hold_until}` and the
   pane says needs_you;
2. the first valid `answer` wins: its outcome is `executed` with
   `result.state: "submitted"`, and the helper prints
   `{"hookSpecificOutput": {"hookEventName": "PreToolUse",
   "permissionDecision": "allow", "updatedInput": {"questions": …,
   "answers": {"<question text>": "<label>[, <label>…][, text]"}}}}`;
3. PostToolUse with the same `tool_use_id` sends
   `question.resolved {outcome: "accepted", still_open: false, answer_echo}`.

Otherwise: at 570 s remotea lets go and the question shows in the terminal
(`question.resolved {outcome: "timed_out", still_open: true}`; answered
there later → `answered_locally`); the hook killed early (Esc) →
`canceled`; the process exiting or a new prompt → `canceled`. A subagent's
question (`agent_id`) is never held. `remote_answerable` is always false on
`question.resolved`. Claude's PermissionRequest is captured, not answered
(`permission: "capture"` in `harnesses`).

### Context (SessionStart)

The SessionStart hook asks the server (`remotea.context`), which sends
`context.request {req_id, surf, incarnation, provider, provider_session_id,
source, cwd, run_id, generation, task_id}` and waits 2.5 s for
`context.response {req_id, text, run_token?}`. The text (≤ 16 000 chars) is
printed for the agent, followed by `Eridani run token: <token>` when there is
one. With no answer in time, one line naming the tool, session and run is
printed instead; a late response is dropped. Nothing is printed when the link
is not enabled.

### Other frames

remotea also sends: `question`, `question.resolved`, `verify.result
{attempt_id, run_id, generation, turn_seq, plan_revision, verify_id,
workspace_fingerprint ("<HEAD>:<sha256 of the branch, status, diff and
untracked contents>"), exit_code, tail (last 4000 chars), truncated, duration_ms,
timed_out, canceled, error?}` and `worktrees.report {worktrees: [...]}` (on
ready, after a spawn or exit, and every 2 min when it changed). `turn` now
carries the run binding taken when the turn's prompt was submitted, Claude's
`prompt_id` as `provider_turn_id`, and `interim: true` for a Stop with
background tasks still running. `sessions.snapshot` surfaces carry `task_id,
target, worktree, branch, stop_requested, questions`; `status` carries
`effective_permission_mode`. `caps` adds `question, context, spawn, input,
answer, stop, verify, runs.snapshot, worktrees.report`.

`remotea status --json` adds, per session: `eridani {runId, generation,
taskId}`, `worktree`, `branch`, `stopRequested` (null for other sessions;
`version` stays 1).

## Stage D: verification after turns

Code: `remote-server/src/verify-attempts.ts` (when, and under which attempt
id), `verify-runner.ts` (the run itself). `caps` adds `verify.auto`.

**Which runs verify.** A run carries a verify config on its binding,
`{verifyId, planRevision}`, learned from any of: the spawn's `verify
{verify_id, plan_revision}`; `runs.snapshot` entries (`verify` present sets
it, `null` clears it, absent leaves it); a `verify` command, when the run has
none yet or the command names a newer plan revision. The verify id must be one
of the execution target's `verify` entries (a spawn naming another is
rejected).

**When.** After every root turn the host captures on a bound surface (a `turn`
frame), 2 s later. Not after an interim Stop (`interim: true`, background
tasks still running), not for a turn of an older generation than the run's
current one, not while a stop is requested. One attempt at a time per
surface:

| Event | Effect |
|---|---|
| a newer turn inside the 2 s | replaces the waiting attempt (only the newer turn is verified) |
| a newer turn while an attempt runs | the process tree is killed; its `verify.result` says `canceled: true`; the newer turn's attempt follows |
| a `stop` (command or runs.snapshot), a steer, the process exiting | the running attempt is canceled the same way; a waiting one is dropped without a result |
| the target's timeout | the tree is killed (SIGTERM, SIGKILL 2 s later); `timed_out: true` |

**Attempt ids and the tuple.** Eridani matches results on `(run_id,
generation, turn_seq, plan_revision, attempt_id)`. A host-started attempt
mints `local:<uuid>` and says `initiator: "host"`; its `generation` and
`turn_seq` are the TURN's (not the run's current ones), its `plan_revision`
the config's. An Eridani `verify` command keeps Eridani's `attempt_id` and is
deduplicated against host attempts for the same tuple (and `verify_id`):

- a host attempt still waiting → it starts at once, under Eridani's id;
- a host attempt running → Eridani's id adopts it: one run, one result, with
  `adopted: "local:…"`;
- a host attempt finished, the tree unchanged since → its result is sent again
  under Eridani's id (`adopted` set, same `duration_ms`), nothing reruns;
- an attempt for a NEWER turn is running → the command is `rejected`
  ("superseded by turn N"); for any other tuple it cancels the running attempt
  and runs.

**Fingerprint and `stale_workspace`.** `workspace_fingerprint` is
`<HEAD>:<sha256>` over the branch name, `git status`, the diff against HEAD
and every untracked file's content, taken before the run; `workspace {head,
branch, tree}` says what it was taken from. It is also taken when the turn
ends (`turn_fingerprint`) and after the run. If the turn's fingerprint differs
from the one before the run (someone edited the checkout in between), or the
one after differs from the one before (the run, or anything beside it,
changed the tree), the result says `stale_workspace: true`. A verify command
that writes files git does not ignore therefore always reports stale: ignore
its outputs.

`verify.result` now: `{attempt_id, run_id, generation, turn_seq,
plan_revision, verify_id, workspace_fingerprint, workspace {head, branch,
tree}, turn_fingerprint?, stale_workspace, initiator: host|eridani,
adopted?, exit_code|null, tail, truncated, duration_ms, timed_out, canceled,
error?}`. Output is the last 4000 characters of stdout and stderr together.

**Restart.** The latest attempt per surface is kept on the session record.
A waiting or running attempt at a restart becomes `interrupted`: a host
attempt is not rerun (the next turn makes a new one, and Eridani's own
deadline covers the missing result); a commanded one is settled by the
journal (`failed`, "interrupted by a server restart").

**Generation of every event (F07).** Each input Eridani types (the spawn's
prompt, a queued input, a steer) has its generation persisted on the binding
(`acceptedInput`) before the bytes are sent. The agent's next accepted prompt
(UserPromptSubmit) binds its turn to that generation and consumes it, even if
`runs.snapshot` advanced the run in between; a prompt typed in the terminal
(nothing accepted in the last 60 s) takes the run's current generation. The
binding lives on the turn cursor, so `turn`, `question`,
`question.resolved` and the `verify.result` after that turn all carry the
generation that produced them. A duplicate Stop for the same logical turn
(same provider turn id, or same turn number) is dropped: no second turn,
`turn_seq` does not advance, no second attempt.

**Status.** `remotea status --json` adds, per session, `verify {attemptId,
state: pending|running|passed|failed|timed_out|canceled|error|interrupted,
startedAt}` (null when none ran).

## Stage E: collector cutover

The Python collector (`~/jarvis/scripts/session_collector`, a systemd user
timer every 2 minutes) and this server's collector report the same sessions.
In parity mode only the Python one is stored. The cutover makes this one the
store's source and stops the other; never both at once (C10: no dual
authoritative reporting with different freshness rules).

**Modes.** `eridani.json.collector`:

| | `parity` (default) | `authoritative` |
|---|---|---|
| `session.report` | `parity: true`: compared, not stored | `parity: false`: stored (Eridani's `report`) |
| Delivered fingerprints | `eridani-collector.json` | `eridani-collector-authoritative.json` |
| hello caps | stage D's | stage D's + `collector.authoritative` (informational) |
| `remotea status --json` | `version: 1` | `version: 2` |

**Fingerprint after delivery.** As in collector.py, a source's fingerprint is
recorded only once Eridani acked the report that carried it. Authoritative
mode adds three rules so that "recorded" always means "stored":

- Each mode has its own fingerprint file. A report acked as a comparison says
  nothing about what Eridani stored, so the first authoritative scan sends
  every source once, and a rollback to parity resumes from the parity record.
- An ack advances a fingerprint only when the acked report's `parity` flag
  matches the current mode. A parity report still in the outbox at the switch
  (it is resent after the reconnect) advances nothing. In the outbox an
  authoritative report replaces a queued parity one of the same fingerprint
  (the spool revision is `parity:<fp>` / `store:<fp>`; the wire revision stays
  the fingerprint).
- A report Eridani refuses for good is forgotten, so the next scan (2 min)
  sends it again, as collector.py retries a failed PUT on its next run. In
  parity mode a refusal still waits for the source to change.

A scan that was running when the config changed sends nothing through the
new link.

**The status v2 interlock.** `remotea status --json` reports `version: 2`
exactly while `collector` is `authoritative`, and `version: 1` otherwise. v2
has the same fields as v1, plus `server.collector`, which v1 also carries
(additive). The Python collector reads only `version == 1`: on v2 it keeps its
last known terminals and logs "remotea status unavailable; keeping the last
known terminals" on every run. So a Python timer that was forgotten after the
cutover stops learning about remotea terminals, and its journal says why. It
is a tripwire, not a lock: the Python collector still sends its other
reports, so disabling its timer is a required step. Tested against the real
collector.py (`tests/collector-cutover.test.ts`, skipped where ~/jarvis is
absent).

**Legacy hook cleanup.** `remotea hooks --remove-legacy-collector [--dry-run]`
removes the Python collector's Claude Code `SessionStart` hook from
`~/.claude/settings.json`, and nothing else:

- A handler is the collector's only when its command is exactly the script
  `~/jarvis/scripts/session_collector/session_hook.py`, bare or behind
  `python`/`python3`/`pythonX.Y` (by name or absolute path) or
  `/usr/bin/env python3`, with `~`, `$HOME` or `${HOME}` spelled out or not.
  The same file name elsewhere, extra arguments, or a compound command
  (`;`, `|`, `$(…)`, `bash -c …`) is not the collector's.
- Handler by handler: other handlers in the same `SessionStart` group stay, a
  group left empty is dropped, other events are untouched. The first remotea
  change to the file keeps the original as `settings.json.remotea-backup`.
- It prints what it removed and, when
  `~/.config/systemd/user/eridani-collector.timer` exists,
  `systemctl --user disable --now eridani-collector.timer`. It never runs
  systemctl itself, and nothing runs it automatically; `install.sh` only
  mentions it when the hook is present.
- What the hook did: it told a Claude session its own session id for the
  `session_link` MCP tool. Sessions in remotea terminals get that line from
  SessionStart context (context.ts) whenever the link is enabled. A Claude
  session started outside remotea in this WSL no longer gets it.

**Steps** (mirror Eridani's retirement steps in
`~/jarvis/scripts/session_collector/README.md` § Retirement;
`remotea eridani collector authoritative` prints them):

1. Before. Eridani's parity summary shows "ready for cutover" (7 consecutive
   clean days), and this release is the one installed and running.
2. `remotea eridani collector authoritative`. Within 30 s the link reconnects
   with `collector.authoritative`, `status --json` turns v2, and every source
   is sent once more, without the parity flag.
3. `systemctl --user disable --now eridani-collector.timer`.
4. `remotea hooks --remove-legacy-collector --dry-run`, then without
   `--dry-run`.
5. Watch one cycle. `remotea eridani status` shows the link ready, no
   refusals, the outbox draining. A new or resumed session appears in Eridani
   with its resume hint. The agents' MCP key (`cli-agents`) still works: it is
   not part of the cutover.
6. One release later, after a clean cutover: remove the collector's units
   (`~/.config/systemd/user/eridani-collector.{service,timer}`, then
   `systemctl --user daemon-reload`) and `~/.config/eridani-collector`, and
   revoke the old collector credential in Eridani (Settings → Integrations →
   Connected agents). Never the link key or `cli-agents`.

**Rollback** (any time before step 6): `remotea eridani collector parity`,
then `systemctl --user enable --now eridani-collector.timer`, and put the
SessionStart hook back by hand if you want it
(`python3 ~/jarvis/scripts/session_collector/session_hook.py`). The parity
fingerprints were kept, so going back sends nothing new.

## Not yet implemented (stage E and later)

- Answering permission prompts (captured only) and Codex questions (no hook).
- Removing worktrees (nominate only, by design).
- Deleting the Python collector's code, units and credential: Davin's step,
  one release after a clean cutover (below), not code here.
