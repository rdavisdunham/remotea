# The Eridani link (stages B to F)

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
| `remote-server/src/eridani-setup.ts` | `remotea eridani setup`: the re-runnable wizard, MCP wiring per harness, the readiness table. |
| `remote-server/src/dispatch.ts` | Stage C: what each command does; recovery on boot and after a reconnect. |
| `remote-server/src/eridani-targets.ts` | Execution targets in `eridani.json`. |
| `remote-server/src/worktrees.ts` | One worktree per branch; the nominate-only cleanup report. |
| `remote-server/src/questions-claude.ts` | Holding Claude's AskUserQuestion (and, through `holdApproval`, Codex's PermissionRequest) for Eridani. |
| `remote-server/src/questions-codex.ts` | The Codex approval shape: items, allow once / deny decision. |
| `remote-server/src/harness-adapters.ts` | Which question kinds each harness may have answered, on which tested versions. |
| `remote-server/scripts/capability-codex.mjs` | Capability test of the Codex adapters against the installed Codex (fake model, scratch home). |
| `remote-server/src/context.ts` | SessionStart context from Eridani. |
| `remote-server/src/verify-runner.ts` | One configured verification, with a workspace fingerprint (and whether it is complete). |
| `remote-server/src/verify-sandbox.ts` | The bubblewrap sandbox verify runs in, and the loopback forwarder. |
| `remote-server/src/doctor.ts` | `remotea doctor`: the readiness checks, the report, and the summary sent to Eridani ([Doctor](#doctor)). |

## Managed direct input and automation hold

Managed Codex and Claude sessions negotiate `input.direct`. An `input` command with
`mode: "direct"` hands the message to the existing provider transport immediately:
Codex uses `turn/steer` with `expectedTurnId` while a turn is active and `turn/start`
when idle; Claude writes a user message with its stable operation UUID to the
existing streaming input. This does not interrupt the worker. The provider decides
when to consume the input. Legacy `queue` and interrupting `steer` modes keep their
semantics, including messages already queued before this capability was available.

The direct message carries `origin: "human"`, `automation_hold: true` and a
monotonic `automation_hold_revision`. The separate `automation.hold` command carries
`run_id`, `generation`, `held`, `automation_hold_revision` and `origin: "human"`;
it also works before the run has attached a surface. Desired hold state travels in
run snapshots so reconnection cannot silently release it. The host persists the
hold, rejects stale automatic commands and removes explicitly tagged automatic
inputs that have not yet been handed to the provider. Human messages and explicit
decision responses remain possible. A hold does not interrupt a worker or undo
input already handed to it. Releasing it requires an explicit newer revision.

`input.receipt` correlates `input_id` with the original command operation and reports
`handed_to_harness`, `provider_acknowledged` or `uncertain`, with run, generation,
surface, incarnation, provider session/turn and timestamp. A successful direct
command outcome reports `receipt: "handed_to_harness"` and whether the provider
acknowledgment is confirmed or pending. Claude's delayed replay of the user UUID
upgrades the receipt separately; a busy turn is not a reason to time out that
acknowledgment. These stages do not assert that the model read the message. Unknown
delivery is never blindly retried, and repeated operation IDs do not send twice.

The negotiated `output.live` event carries published assistant commentary or
responses, never provider reasoning. Each full message snapshot has `run_id`,
`generation`, `surf`, `incarnation`, `session_id`, nullable `turn_id`, `message_id`,
monotonic `sequence`, `at`, `kind` (`commentary` or `response`), `text`, `complete`
and `truncated`. `complete` means the message is complete, not that the turn ended.
The host persists a bounded snapshot for replay after reconnect; Eridani replaces
earlier snapshots by identity and sequence and reconciles completed turn history.
Partial or completed live messages never count as completed turns or trigger a
judge. Normal final-turn capture remains the authority for that.

The Eridani drawer's **Show chat** is local view state and sends no control command.
Accepted **Send** saves the message and holds automation atomically, including while
the link is offline. **Resume automation** waits for reconciliation and an explicit
host-confirmed release. A host without direct support requires an update; the UI
does not silently substitute next-turn queueing. Worker pause, permission decisions,
manual terminal ownership and configured hard limits remain separate controls.

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
- `collector_scope` is `"remotea"` (default) or `"all"`. `"remotea"` reports
  only sessions that ran in a remotea terminal: live now, or remembered in the
  collector state's session → workspace map (`remotea.groups`, merged from both
  modes' files), and never the Windows side. `"all"` reports every Claude Code,
  Claude Desktop, Codex CLI and Codex desktop session, as the Python collector
  did. Anything else reads as `"remotea"`. Switch it with
  `remotea eridani collector scope [remotea|all]`; sessions reported before stay
  in Eridani.

`eridani-token` holds the link key (`eri_bot_…`), mode 0600. The key is sent
only in the `Authorization` header. It is never logged, never written to the
outbox or the status file, and never put in a session's environment.

`webUrl` (optional) is Eridani's web app, for links back to a run (see
[Open in Eridani, and the terminal from Eridani](#open-in-eridani-and-the-terminal-from-eridani)).
It must be `https://` (`http://` only for localhost); without it the host
derives it from `url` (`wss://host/…` → `https://host`).

`eridani-mcp-token` (optional, mode 0600) holds a **separate** bot key that
spawned agents use for Eridani's MCP server; see
[Eridani MCP for spawned agents](#eridani-mcp-for-spawned-agents). Two more
optional keys in `eridani.json` go with it: `mcpKeyFile` (another path for
that file) and `mcpUrl` (the MCP endpoint, when it is not derived from `url`).

The server checks both files' mtime and size every 30 s and starts, restarts or
stops the link to match. Nothing needs a service restart.

## Setup

`remotea eridani setup` does the whole setup in one re-runnable command. It
reads what is already there, changes only what differs, prints a redacted diff
before it touches a harness's config, and ends with exactly what it changed,
what was already right, and what it skipped and why. A second run changes
nothing. It never starts or restarts `remotea.service`.

```
remotea eridani setup [--code <code>|-] [--url <wss://…|https://…>] [--machine <name>]
                      [--link-key <key>|-] [--mcp-key <key>|-] [--no-probe] [--wait <s>]
                      [--scan <dir>]… [--add-repo [<id>=]<path>]… [--claude] [--codex]
                      [--verify <id>=<command>]… [--verify-timeout <s>]
                      [--user-mcp | --no-user-mcp] [--replace] [--hooks]
                      [--yes] [--dry-run] [--json]
```

On a terminal it asks for anything not given as a flag. Keys are read without
echo. `--yes` (or a non-terminal stdin, or `--json`) never asks: every answer
takes its flag or its default. A key given as `-` is read from stdin, one line
each, in the order code, link key, MCP key. This keeps keys out of argv and
shell history.

1. **Link.** The URL comes from `--url`, the setup code, or `eridani.json`. An
   Eridani origin (`https://eridani.example`) becomes its link URL. The link
   key comes from `--link-key`, the code, or the prompt; with none of these,
   the current `eridani-token` is kept. The key is proved with one
   hello → welcome, as `connect` does (`--no-probe` skips this). Then the key
   and `eridani.json` (`enabled: true`, url, machine) are written the way
   `connect` writes them, if they differ. It prints Eridani's host id and
   welcome caps, this build (sha, proto, caps version, link caps, hook
   version), and whether the server is running. With `--wait <s>`, it waits
   for the running link to report `ready`.
2. **Targets.** It lists the configured targets and offers the git
   repositories found two levels under `--scan` folders and under the parent
   folders of existing targets. Worktree roots and repositories that are
   already targets are left out. `--add-repo [<id>=]<path>` adds one without
   asking. A new target gets these defaults:
   - id: the folder name.
   - base: origin's default branch, else the current branch.
   - worktree root: `<repo>-worktrees`.
   - launch: the harnesses whose launcher probe answers, else `claude`
     (`--claude`/`--codex` override this).
   - verify: one entry from `--verify`, else detected: `npm test`,
     `make test`, `uv run pytest` / `python3 -m pytest`, `cargo test` or
     `go test ./...`.

   Existing targets are never edited (use `targets setup` or `targets add --json`).
3. **MCP for coding agents.** The MCP bot key (`--mcp-key`, the code, or the
   prompt) is written to `mcpKeyFile` (default
   `<config dir>/eridani-mcp-token`), mode 0600, for the per-spawn
   `--mcp-config` / `-c` path ([below](#eridani-mcp-for-spawned-agents)). The
   key must be an `eri_bot_` key and not the link key. Setup refuses the link
   key, and a key file that holds it, before it writes anything. Then, for
   each harness whose program is on PATH, it offers a **user-level**
   `eridani` entry, so sessions started by hand have the tools too:
   - Claude Code: `claude mcp add --scope user --transport http eridani
     <origin>/api/v1/external/mcp/ --header "Authorization: Bearer <key>"`
     (in `~/.claude.json`, or `$CLAUDE_CONFIG_DIR`).
   - Codex: a `[mcp_servers.eridani]` table with `url` and `http_headers =
     { Authorization = "Bearer <key>" }` in `~/.codex/config.toml` (or
     `$CODEX_HOME`).
   - OpenCode: `mcp.eridani = {type: "remote", url, headers, enabled: true}`
     in its global config (`~/.config/opencode/opencode.json`, or the
     existing `.jsonc` / `config.json`).

   A harness that is not installed is skipped. An entry that already
   matches is left alone. An `eridani` entry that differs is never replaced
   without `--replace`. Writing needs `--user-mcp` or a yes at the prompt;
   `--no-user-mcp` never writes. The diff names only the `eridani` entry, with
   the key shown as `eri_bot_****`. A file remotea rewrites keeps a
   `.remotea-backup` of its first version and is left at mode 0600, because it
   now holds a key. Codex entries in another form (dotted keys, inline
   tables) and OpenCode files with comments are reported, not rewritten.
4. **Hooks.** It reports the installed helper's `hook_version`, whether it
   matches the one this checkout ships, and which agents lack the hooks. It
   runs `remotea hooks install` only with `--hooks`, because that edits
   `~/.claude/settings.json`; otherwise it prints the command.

Finally it prints the **readiness table**. This is the data hello sends for
each target: the enabled harnesses with each launcher's probe (ready, version
or error, run through the login shell the way a spawn runs it), each verify
entry's status (checked against the service's PATH from the installed
`remotea.service`, else install.sh's default), and `mcp`. It also prints the
MCP wiring per harness. `--json` prints the whole report (`changed`,
`unchanged`, `skipped`, `link`, `readiness`, `mcp`, `hooks`) and nothing else.
`--dry-run` prints the same without writing anything.

`remotea eridani status` prints the same MCP wiring and per-target readiness
after the link lines. Launch and verify come from the running link's hello;
without one, launchers show as `not probed` unless `--probe` runs the probes.

**The one line Eridani prints.** A setup code is `eridani-setup:1:` followed
by the base64url of `{"url": "<origin or link URL>", "link_key": "eri_bot_…",
"mcp_key": "eri_bot_…", "machine"?: "<name>"}`
(`encodeSetupCode` / `parseSetupCode` in eridani-setup.ts). The wizard finds
the code anywhere in a pasted line, so pasting the whole command
`remotea eridani setup --code eridani-setup:1:…` at its first prompt works
too. Pasting at the prompt is better than running that command, because the
keys then stay out of shell history.

## CLI

```
remotea eridani setup [flags]          (see Setup above)
remotea eridani connect [--url <wss://…>] [--machine <name>] [--no-probe]
remotea eridani status [--json] [--probe]
remotea eridani disconnect [--forget]
remotea eridani collect [--dry-run] [--days N]
remotea eridani collector [parity|authoritative]
remotea eridani collector scope [remotea|all]
```

- `connect` asks for the key without echoing it (or reads it from stdin when
  piped), checks it starts with `eri_bot_`, and proves it with one
  hello → welcome before writing anything. Then it writes the key (0600) and
  enables the link.
- `status` reads `eridani-status.json`, which the running server rewrites at
  most once a second. `state` is `disabled`, `stopped` (enabled but no server is
  running it), or the link's state (`connecting`, `ready`, `reconnecting`,
  `auth-failed`). `degraded` says why the link is degraded, the journal first;
  `journal {degraded, unrecorded, refused}` and `spool.degraded` give the
  detail (see [When the journal cannot be written](#commands)).
- `status` also prints the MCP wiring per harness and each target's readiness
  ([Setup](#setup)); `--json` adds them as `mcpWiring` and `readiness`.
- `status` prints one `doctor` line when the running server has a doctor
  summary: its counts and the first warn/fail ids (`remotea doctor` has the
  detail). `--json` has it as `doctor`.
- `connect` proves the key with the same identity the server's hello sends
  (`build_sha`, `build_dirty`, `caps_version`, `hook_version`, and the caps for
  the configured collector mode), so Eridani sees the probe as this build, not
  as a stage B host. It still reports no harnesses or targets.
- `disconnect` disables the link; `--forget` deletes the key too.
- `collect --dry-run` prints what the collector would report, in the same table
  as `collector.py --dry-run`. Without `--dry-run`, it asks the running server
  to scan now (picked up within 30 s).
- `collector` with no argument prints the mode; with one, switches it (the
  rest of `eridani.json` is kept) and prints the cutover checklist or the
  rollback steps. The server follows within 30 s.

`remotea status --json` gains, additively (`version` stays 1 until the collector cutover, which makes it 2: see [Collector cutover](#stage-e-collector-cutover)):
`sessions[].agentState`, `sessions[].incarnation`, `sessions[].turnSeq`, and
`server.eridani {enabled, state, unacked, lastAckAt, advertised}`
(`advertised`: what the running link's hello says now, see
[Capabilities and build identity](#capabilities-and-build-identity); null
without a running link). Build identity adds `server.build`,
`server.diskBuild`, `server.proto`, `server.capsVersion` and `server.hooks`
(same section). The PTY keeper (S-Q5, [upgrade.md](upgrade.md)) adds
`server.ptyKeeper {enabled, running, socket, pid, version, proto, startedAt,
owner, sessions, alive, ids, aliveIds}` and `sessions[].inKeeper`; the status
file (`remotea eridani status --json`) adds `draining {reason, since} | null`.

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
| `hello` | | | `server_id, boot_id, hostname, machine, proto: 1, version, build_sha, build_dirty?, caps_version?, hook_version?, caps, harnesses, targets?` (see [Capabilities and build identity](#capabilities-and-build-identity)), and `degraded_reason?` (string, only while degraded: `journal_unavailable (<stage> failed: <code>)` first, else the outbox's `disk-full` / `write-failed: <code>` / `read-failed: <code>` / `spool-full`; absent when healthy), and `doctor?` (the latest [doctor summary](#doctor); absent until the server has computed one), and `draining?: true` (S-Q5: only while the server drains for a restart, see [Draining for a restart](#draining-for-a-restart)) |
| `sessions.snapshot` | control | (per connection) | Sent after every welcome. `part {of, i, n}`, `surfaces[]`, `journal {pending, uncertain}`. Never persisted. |
| `command.outcome` | control | `outcome:<op_id>` | Stage B only reports `rejected` (`unsupported` / `expired`). |
| `status` | live | `status:<surf>`, numeric `revision` | `surf, incarnation, state, since, reason?, provider?, provider_session_id?`, and `trouble? {kind, since, detail?}`: the session is in trouble its state does not show. `kind` is `stalled` (the host's inactivity watchdog: `working`, but no hook event and no terminal output for `stallMinutes` in config.json, default 15, 0 = off; cleared by any new sign of life) or a harness-reported `errored` / `rate_limited` / `auth_expired` (reserved: nothing sends these yet). Absent when healthy. Additive: an Eridani that does not read it sees the state as before. A server restart never marks a resumed session stalled: the clock starts again. |
| `turn` | live | never | `surf, incarnation, run_id: null, generation: 0, provider, tool, provider_session_id, provider_turn_id, root: true, seq, text, truncated, missing, source, prompt?, prompt_truncated?, ended_at` |
| `prompt` | live | never | `surf, incarnation, run_id, generation, provider, tool, provider_session_id, seq, text, truncated, at`. A root prompt as it was submitted, only for a run-bound surface and only to an Eridani whose welcome advertised `prompt` (see Turn capture). |
| `exit` | live | never | `surf, incarnation, code, exited_at` |
| `host.state` | control | `host.state` (ephemeral) | `draining, reason?`. S-Q5: the server started (`draining: true, reason: "restart"`) or stopped draining. Only to an Eridani whose welcome advertised `draining`; see [Draining for a restart](#draining-for-a-restart). |
| `doctor` | bulk | `doctor` (ephemeral) | `at, ok, warn, fail, items[{id, level, summary, fix?}], truncated?`. Only to an Eridani whose welcome advertised `doctor`, and only when the findings changed (see [Doctor](#doctor)). |
| `session.report` | bulk | `<tool>:<session_id>`, `revision` = fingerprint | `parity, tool, session_id, report` (the HTTP collector's `SessionInput`, unchanged) |
| `ack` | | | For inbound commands. |
| `bye` | | | On disable or shutdown. |

`caps` is `session.report, session.report.parity, turn, status, exit,
sessions.snapshot, chunking, journal`. `harnesses` is
`{claude|codex: {version, observe, capture, question: false, context: false, resume}}`
(stage B; for what later stages send, see
[Harness capability matrix](#harness-capability-matrix)).

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
  `ack ok:false error:"DIGEST_MISMATCH"`. Since stage F the digest is
  recomputed for every inbound command, so a body that does not match its own
  digest is refused the same way and never journaled. Frames before welcome,
  and frames whose `conn_epoch` is not the welcome's, are ignored.

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
- A torn final line from a crash is cut off at load. A failed write keeps
  events in memory and marks the outbox degraded: `disk-full` for ENOSPC, EIO
  and the like, or `write-failed: <code>` for anything else, such as EACCES
  or a short write. After a failed write nothing more is appended, because
  the file may end in a torn line. The next write rewrites the whole file
  from memory instead, and the first rewrite that succeeds clears the
  degradation. An outbox that cannot be read at start (`read-failed: <code>`)
  is never overwritten. Events stay in memory until it can be read, and then
  the two are merged. `spool-full` clears once acks make room. The outbox is
  memory-first on purpose: a degraded outbox can lose events across a
  restart, but it never runs anything. The status file shows it as
  `spool.degraded`, and as `degraded` when the journal is healthy.

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
  the rollout tail, same turn id: `task_complete.last_agent_message` or an
  `item_completed` AgentMessage with `phase: "final_answer"` (Codex 0.166.0,
  checked against real rollouts; 0.166 no longer writes the older
  `agent_message` event, which is still read). Claude has no fallback:
  transcripts are not read.
- **Redaction.** Text and prompt go through the collector's redaction before
  anything is stored or sent.
- **Apps.** They still get the `Stop` event, without the server-only fields.
- **Live prompts.** A root, non-synthetic `UserPromptSubmit` on a surface
  bound to a run is also sent at once as a `prompt` frame, so the run timeline
  shows what was typed before the turn ends. It carries the binding taken at
  submit (`run_id`, `generation`), the redacted text cut at 4,000 code points
  (`truncated`), the hook's time (`at`) and `seq = turnSeq + 1`: the number the
  Stop that ends this turn assigns, so `prompt.seq === turn.seq` for the turn
  (or the interim turn) that answers it. A synthetic hand-back prompt, a
  subagent's prompt, an empty prompt and an unbound surface send nothing. The
  frame goes only to an Eridani whose welcome advertised `prompt` (hello
  offers `prompt` too); otherwise it is dropped, not spooled, and the `turn`
  still carries `prompt` / `prompt_truncated` as before.

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

A verify entry may also set `env`, and the sandbox settings `isolation`,
`network`, `ports` and `mounts` ([Verify isolation](#verify-isolation)), and
`notifyAfter` (seconds, at least 60 and under its `timeout`): Eridani's soft
threshold for that entry, after which it says the verification is still
running (hello sends it as `verify_status[].notify_after_s`). `setup` and
`targets add` default `--verify-timeout` to 7200 s: a full suite run beside
other verifications on one machine can take well over 10 minutes, and the
timeout is the hard ceiling.
A target may also declare dependency preparation and resource limits
([Target templates](#target-templates-s-q3)).

```
remotea eridani targets list [--json]
remotea eridani targets setup <repo-path> [--id <id>] [--worktree-root <path>] [--harness claude|codex] [--model <name>] [--no-harness] [--yes] [--json]
remotea eridani targets add --id <id> --repo <path> --worktree-root <path> [--base main] [--claude] [--codex] [--verify <id>=<command>]… [--verify-timeout <s>] [--prepare <id>=<command>]… [--prepare-timeout <s>] [--max-runs <n>]
remotea eridani targets add --json '<target>'
remotea eridani targets remove <id>
remotea eridani worktrees [--json]
```

`targets setup` is the guided way to add a target
(`remote-server/src/eridani-target-setup.ts`, whose header documents every
flag and the `--json` shape):

1. **Propose.** An installed harness reads the repository headless and
   read-only (Claude Code: `claude -p --model opus --restricted` with only
   Read, Grep and Glob, no MCP servers, nothing saved; Codex: `codex exec` in
   its read-only sandbox) and answers with one JSON object `{base,
   prepare:[{id, argv, cwd?}], verify:[{id, argv, cwd?, why}], notes}`. The
   answer is untrusted: only those keys, ids as target ids, every argv a list
   of words (no command string, no `sh -c`, no `&&`, `|` or redirects), `cwd`
   inside the repository; one wrong entry drops the whole answer. With
   `--no-harness`, with no harness installed, or with an unusable answer, the
   proposal comes from the same file-name heuristics `setup --add-repo` uses,
   and the output says so and why.
2. **Try the check, once confirmed.** Nothing proposed runs before a person
   has seen it (the heuristics' commands included, so there is one rule). On
   a terminal the proposed prepare and verify commands are printed first,
   then one question, "Run this check now in the sandbox?" (default no);
   `--yes` runs it without asking. Without a terminal, or with `--json`, and
   without `--yes`, it is not run: it is reported `not_run` with
   `needs_confirmation: true` and a reason. `--no-check` never runs it. Once
   confirmed, each proposed verify entry runs once in the repository checkout
   through the verify runner, in the bubblewrap sandbox (required here) with
   no network. The result (passed, failed, timed out, not run) and how long
   it took are printed; a check that did not pass, or that you chose not to
   run, is left out of the target unless `--keep-failing`. `prepare` is not
   run here.
3. **CI.** Whether a `.github/workflows/*.yml` runs on `pull_request`; with no
   local check, "CI is the gate" (or "nothing gates this target") is printed
   as an explicit choice.
4. **Confirm and save.** The proposed target is printed and one y/N question
   asked (`--yes` skips it); it is saved through the same path as `targets
   add`. Without a terminal and without `--yes` nothing is written.
   `--json` prints the proposal as one object, runs no proposed check and
   writes nothing unless `--yes` is also given, so another program can ask
   for a proposal, show it to a person, and call again with `--yes`, which
   runs the check and saves.

**From Eridani.** The same setup runs without a terminal through the link
command [`target.setup`](#commands) (cap `target.setup`): `confirm: false`
returns the proposal (as `--json`), Eridani shows it, and `confirm: true`
sends the shown target back. That confirm is not read again by a harness: the
host checks it, tries each check once in the sandbox, keeps the passing ones,
saves it and sends a new hello that lists it. A host without a working
sandbox still answers proposals; a confirm with a check then fails with the
reason.

Targets are read on every use: adding one needs no restart and does not
reconnect the link. `hello` lists them (`targets: [{id, repo, worktree_root,
harnesses, enabled, launch, verify, verify_status, migrations?, mcp?,
template?, prepare?}]`, never argv or env) for Eridani's target picker; the
next connect carries a new target, and its launcher is probed on the next 30 s
check. What each field means is in
[Capabilities and build identity](#capabilities-and-build-identity). An entry
of `targets` that does not pass the schema check is never listed; `remotea
doctor` reports it (`target.<id>.config`) and the server logs it.

#### Target templates (S-Q3)

A target is a template: the repository, the harness launch, dependency
preparation, the verification environment, migrations and resource limits,
defined once. Two optional keys complete it; a target without them behaves
exactly as before:

```json
"prepare": [
  { "id": "api", "argv": ["/home/davin/.local/bin/uv", "sync", "--locked", "--group", "dev"], "timeout": 900 },
  { "id": "web", "argv": ["npm", "ci"], "cwd": "apps/web", "timeout": 900, "env": { "PATH": "/home/davin/.nvm/versions/node/v22.12.0/bin:/usr/bin:/bin" } }
],
"limits": { "maxRuns": 3, "minFreeMiB": 4096 }
```

| Key | Meaning |
|---|---|
| `prepare[]` | Up to 8 steps `{id, argv, cwd?, timeout, env?}` (timeout ≤ 2 h), run in order in a managed worktree before the agent starts: in a new worktree, and again in a reused one whose last preparation failed, never finished, or ran different steps. Fixed argv, no shell, the minimal verify environment (`PATH`, `HOME`, `LANG`, `CI=1`, `TERM=dumb`, plus the step's `env`), as the server user with its network, not sandboxed (it installs dependencies; it does not run the agent's code). A step over its timeout is killed with its process tree. The first failure stops the steps and the spawn: no agent starts. Every step's output goes to `<worktree git dir>/remotea-prepare.log` (e.g. `<repo>/.git/worktrees/<name>/remotea-prepare.log`: outside the working tree, gone with the worktree), with the state in `remotea-prepare.json` beside it. |
| `limits.maxRuns` | 1 to 64: at most this many live Eridani sessions on the target at once (spawns in flight count). One more spawn is `rejected` `target_busy` with `result {limit, running}`. |
| `limits.minFreeMiB` | Below this much free space where the worktrees live, the target is not ready. |

**Validated before it is advertised.** Every hello (and every `remotea
doctor`) checks the whole template; `remotea eridani targets add` prints the
same check after saving:

| `check` | Level | When |
|---|---|---|
| `repo` | fail | The repository folder does not exist, or is not a git checkout. |
| `worktree_root` | fail | It exists and is not a writable folder, or does not exist and its nearest existing parent is not writable. |
| `base` | fail | The base is not a local branch, an `origin/<base>` branch or a tag of the repository (a git failure is a `warn`). |
| `launch` | fail | No harness is enabled. |
| `prepare.<id>` | fail | The step's program does not resolve the way it will run (absolute and executable; relative to the cwd and tracked in the repository; or on the service `PATH`, or the step's own `env.PATH`), or its `cwd` is not a folder in the repository. |
| `limits.disk` | fail | Less free space than `limits.minFreeMiB` where the worktrees live. |
| `verify.<id>` | warn | The verify entry is not ready (the same reason as `verify_status`). Not blocking: Eridani gates verification per run on `verify_status`. |
| `migrations` | warn | `migrations.dir` is not a folder in the repository checkout. |

The result is `targets[].template: {ready, problems?: [{check, level,
reason}]}` (fails first; `reason` is one line and never argv, env or a key)
and `targets[].prepare: string[]` (the step ids, when the target declares
any). A target that is not ready is still listed, with its reasons and
**`harnesses: []`**, so an Eridani that only reads `harnesses` already starts
nothing there. Dispatch checks the template again at every spawn (it may have
broken since hello): a spawn on a target that is not ready is `rejected`
`target_not_ready: <the fail reasons>` with `result {template}`. Both fields
are optional and additive; an older Eridani ignores them, an older host omits
them.

### Capabilities and build identity

hello keeps these facts apart (S-S1); `caps_version: 2` says a host does
(`ERIDANI_CAPS_VERSION`; absent means 1, where every harness claimed `spawn`):

| Fact | Where | How it is known |
|---|---|---|
| Protocol support | `caps[]`; each harness's `observe, capture, question, question_kinds, context, resume, steer, permission, loop, launch_flags` | What this build implements. `question` is narrower: only a kind whose adapter was tested on the installed version, with its hook wired (see [Harness capability matrix](#harness-capability-matrix)). |
| Installed harness | `harnesses.<h>.installed: boolean`, `version: string \| null`, `launch_error?: string` | `<bin> --version` run exactly as a spawn runs it: the login shell (`$SHELL -l -i -c`), the session environment (pty-spawn.ts), from `$HOME`. One probe per distinct `(harness, bin)`: the bare name, plus each target's `launch.<h>.bin`. The server runs under systemd with a minimal PATH, so a plain exec would prove nothing. |
| Target permission | `targets[].enabled: ("claude"\|"codex")[]` | The target's `launch` lists the harness. |
| Spawnable | `harnesses.<h>.spawn: boolean`; `targets[].harnesses`; `targets[].launch.<h> {ready, version, error?}` | `targets[].harnesses` is `enabled` minus launchers whose probe failed (always a subset of `enabled`). `spawn` is true only when some target enables the harness AND its launcher works. Eridani checks both (jarvis PR #91). |
| Verification readiness | `targets[].verify: string[]`; `targets[].verify_status: [{id, ready, reason?, timeout_s?, isolated?, isolation?, isolation_reason?}]`, same order | The entry's program resolves the way verify-runner.ts runs it: no shell, `verifyEnv` (the service's PATH, or the entry's own `env.PATH`); an absolute program must be executable, a relative one (`./scripts/verify.sh`) is checked in the repository; the `cwd` must exist in the repository. `reason` never contains the argv (`uv` not on the service PATH reads "its program is not on the service PATH …"). |
| Template (S-Q3, additive) | `targets[].template: {ready, problems?: [{check, level, reason}]}`; `targets[].prepare?: string[]` | The whole target checked before it is advertised ([Target templates](#target-templates-s-q3)). `ready: false` empties `harnesses`. |
| Verification timeout (additive) | `verify_status[].timeout_s: number` | The entry's configured `timeout` in seconds, which verify-runner.ts enforces (a timeout is required in every entry, so it is always present from this build on). Eridani's verify deadline follows it (`run_coordinator.verify_deadline`: `timeout_s` plus a grace, never under its 11-minute default, which it also uses when a host does not send the field). |
| Verification soft threshold (additive) | `verify_status[].notify_after_s?: number` | The entry's `notifyAfter` in seconds, sent only when set. Eridani's per-entry "still running" notice; verification keeps going until `timeout_s`. |
| Managed runs (additive) | `harnesses.<h>.managed: boolean` and `targets[].launch.<h>.managed: boolean`, each with `conformance`, `launcher_version`, `conformance_step?`, `conformance_message?`, `conformance_at?` | Whether that launcher may run managed (structured-transport) sessions, from its conformance probe ([Launcher conformance](#launcher-conformance)). Show the target row's `launch.<h>` fields: they describe that target's own launcher; `harnesses.<h>` describes the bare name's (or another admitted launcher's). |
| Verification isolation (S-N4, additive) | `verify_status[].isolated: boolean`, `isolation: "bwrap" \| "none"`, `isolation_reason?: string` | Whether a run of the entry now would be sandboxed ([Verify isolation](#verify-isolation)): `bwrap` is on the service PATH and a probe sandbox works. Not being isolated does not make an entry unready (`ready` stays true, the reason is in `isolation_reason`, e.g. "bwrap (bubblewrap) is not installed on the service PATH"), except for an entry that demands `isolation: "bwrap"`: it would be refused, so it reports `ready: false` with that reason. |

Probes run before the link first starts, so the first hello is already
right (a slow login shell delays the connect, by at most 20 s per probe).
Later link starts reuse the last results and refresh them in the background;
every launcher is probed again every 10 minutes, and a new target's on the
next check. hello is sent once per connect, so a change shows from the next
connect on. A probe failure is logged once per change
(`eridani: codex launcher \`codex\`: not ready: …`).

### Launcher conformance

Managed runs drive Claude Code and Codex through their structured transports
(managed-harness.ts), which change between versions. Instead of a version
allowlist (Claude Code updates itself about twice a day), every installed
launcher at or above the adapter's floor is probed once per binary
(launcher-conformance.ts, launcher-conformance-probe.ts):

- **Floor.** Claude Code 2.1.312 (the first version whose PreToolUse hook can
  `defer` a tool and report `tool_deferred`, which managed questions rely on);
  Codex 0.166.0 (the app-server protocol the adapter was generated and
  verified against: `turn/steer` with `expectedTurnId`, `clientUserMessageId`,
  `approvalsReviewer`, `model/list`). Below it: `below_floor`, never probed.
- **Probe.** When the server starts and whenever a launcher's `--version`,
  resolved path or mtime changes (launchers are re-read every 10 minutes),
  the real binary is started by the real adapter, through the login shell,
  against a scratch config folder and a local fake model API. No account, no
  paid model call, nothing in `~/.claude` or `~/.codex` read or written; each
  turn is checked to have reached the fake. Steps (20 s each, 90 s in all;
  about 2 s each on the installed versions):
  - Claude: `help` (every flag the adapter passes, and the `--permission-mode`
    choices `plan`, `auto`, `manual`), `initialize` (model list with
    `supportedEffortLevels` and `supportsAutoMode`; started in `auto`),
    `permission_mode` (`manual`, `auto`), `user_echo` (the user message is
    replayed with its uuid), `hook_callback` (PreToolUse reaches the host with
    `hook_event_name`, `tool_name`, `tool_input`, `tool_use_id`),
    `approval_allow` / `approval_deny` (`can_use_tool` reaches the host and
    the answer is obeyed), `question_defer` (AskUserQuestion is deferred,
    the adapter resumes with `--resume` and the model receives the answer),
    `interrupt` (a turn in flight ends).
  - Codex: `help` (`app-server --stdio`), `initialize`, `model_catalog`
    (`model/list` with `supportedReasoningEfforts` and `isDefault`),
    `thread_start` (the adapter's sandbox, approval policy and reviewer),
    `user_echo` (`clientUserMessageId` comes back as the user item's
    `clientId`, then an agent message), `approval_allow` / `approval_deny`
    (`item/commandExecution/requestApproval` answered `accept` / `decline`),
    `steer` (`turn/steer` on the active turn), `interrupt` (the turn ends
    `interrupted`), `steer_idle` (steering a finished turn is rejected with
    the message the adapter recognises), `resume` (`thread/resume`).
  After a failure the remaining steps are `skipped`.
  `REMOTEA_LAUNCHER_PROBE_TURNS=off` skips the steps that drive a turn; they
  are reported `skipped` ("not probed") and do not fail the probe.
- **Result.** `<config dir>/launcher-conformance.json` keeps, per launcher,
  the version, resolved path and mtime it ran against, every step with
  `pass`/`fail`/`skipped`, its time and message, and when. A pass admits that
  binary until it changes; a failure is retried after an hour, or at once
  with `remotea launcher probe`. When a probe settles (or the CLI writes a
  new result, read within 30 s), the server reconnects so Eridani gets a new
  hello; at startup the first hello waits for the probes.
- **Overrides** (the service environment): `REMOTEA_MANAGED_CLAUDE_FORCE` /
  `REMOTEA_MANAGED_CODEX_FORCE` (`conformance: "forced"`, admitted without a
  probe, logged) and `REMOTEA_MANAGED_CLAUDE_BLOCK` /
  `REMOTEA_MANAGED_CODEX_BLOCK` (`"blocked"`, wins over FORCE). Both take a
  comma-separated list of exact versions. `REMOTEA_MANAGED_CLAUDE_MAX` is no
  longer read (a warning is logged when it is set).

What hello says, per launcher (`targets[].launch.<h>`, and the same fields on
`harnesses.<h>`):

| `conformance` | `managed` | Meaning; what Eridani shows |
|---|---|---|
| `verified` | true | The probe of this exact binary passed (`conformance_at`). |
| `forced` | true | Admitted by `REMOTEA_MANAGED_<H>_FORCE`, not probed. |
| `probing` | false | The probe is running; a new hello follows when it settles. |
| `failed` | false | `conformance_step` failed: "Claude 2.1.319 failed approval_allow: the command was decided without asking the host (no can_use_tool)". |
| `unverified` | false | Not probed yet, or the launcher did not answer `--version` (`conformance_message`). |
| `below_floor` | false | Older than the floor. |
| `blocked` | false | On `REMOTEA_MANAGED_<H>_BLOCK`. |
| `unsupported` | false | Not Linux, or no readable version. |

`launcher_version` is the version the verdict applies to. A managed spawn
for a launcher that is not admitted is rejected as before ("managed harness
protocol is not verified for this installed launcher"); a managed run waiting
to resume after a restart waits while its launcher is `probing`.

Build identity (S-S5). `npm run build` runs `scripts/build-info.mjs` after
tsc: it writes `dist/build-info.json` (`{name, sha, dirty, built_at}`, sha from
`git rev-parse HEAD`, `dirty` from tracked changes; `"unknown"` without git).
The server reads it once at start, so a rebuild without a restart does not
change what it reports.

| Field | In | Type |
|---|---|---|
| `build_sha` | hello, status file `advertised` | `string`: 40 hex, or `"unknown"` (no build-info.json: an older build, or the sources run directly) |
| `build_dirty` | hello | `boolean`, absent when unknown |
| `caps_version` | hello | `number` (2) |
| `hook_version` | hello | `string \| null`: the first 12 hex of the sha256 of the installed `~/.local/share/remotea/cli/wmux-hook.js`, null when not installed |
| `version` | hello (unchanged) | the package version, `0.1.0`; Eridani keeps showing it, `build_sha` goes beside it |

`remotea status --json` (additive, `version` unchanged):
`server.build {sha, dirty, builtAt, pid, startedAt, version} | null` (the
RUNNING server's, from `server-info.json`, which it writes at start; null when
the server is not running), `server.diskBuild {sha, dirty, builtAt}` (the
dist on disk: what a restart would run), `server.proto` (1),
`server.capsVersion` (2), `server.hooks {installed, bundled, current}` (the
helper agents run, the one this checkout ships, and whether they match), and
`server.eridani.advertised` (the hello fields above, from the link's status
file). `remotea status` prints one line from these (`build 1a2b3c4d5e6f; on
disk 9f8e… (restart to run it); proto 1 caps v2; hooks …`), and `remotea
eridani status` prints the advertised harnesses and each target's launch and
verify readiness. The server's start log line names the build too.
A target may also name its own `mcpKeyFile` (see below).

### Eridani MCP for spawned agents

A run's agent reports through Eridani's MCP tools: `submit_plan`,
`submit_plan_review` (hyperplan reviewers), `task_step`, `task_interview`
and `session_link`. A fresh worktree has no
`.mcp.json`, and the host may have no user-scope server, so every spawn (and
every resume) brings its own. Nothing is written to the worktree or to the
user's Claude or Codex settings.

- **Claude Code**: `claude --mcp-config <config dir>/eridani-mcp/<surf>.json
  --model … --permission-mode auto "$ERIDANI_PROMPT"` (a read-only spawn
  puts its tool lists between the two and ends with `--permission-mode
  dontAsk`). The file (mode 0600,
  folder 0700, removed with the session) is
  `{"mcpServers": {"eridani": {"type": "http", "url": "<mcp url>", "headers":
  {"Authorization": "Bearer <key>"}}}}`. There is no `--strict-mcp-config`,
  because that would hide the user's own servers.
- **Codex** (0.166): `codex -c 'mcp_servers.eridani.url="<mcp url>"' -c
  'mcp_servers.eridani.bearer_token_env_var="REMOTEA_ERIDANI_MCP_TOKEN"'
  --disable daemon_auto_start -m …`. The key is put in
  `REMOTEA_ERIDANI_MCP_TOKEN` in the environment of that launch only. It is
  not written to `eridani-runs.json`, and Eridani's `env` (`ERIDANI_*` only)
  cannot set it. `codex resume` takes the same `-c` overrides.
- The MCP URL is `https://<host of url>/api/v1/external/mcp/`. The trailing
  slash is required. `mcpUrl` in `eridani.json` overrides it, and it must be
  `https://` (`http://` only for localhost).
- The key is read from the target's `mcpKeyFile`, else the global
  `mcpKeyFile`, else `<config dir>/eridani-mcp-token`. A path may be
  absolute, `~/…`, or relative to the config dir. It is re-read on every
  spawn and resume, so a new key needs no restart. It must be an `eri_bot_`
  key and **not** the link key: a file holding the link key is refused.
- **Minting the key** (the owner, once per machine): in Eridani, Settings →
  Connections → Bot keys, create a bot key with the scopes `agents:session`,
  `tasks` (read/write) and `notes` (read/write). Save it as
  `~/.config/remotea/eridani-mcp-token`, one line, mode 0600.
- The key never appears in argv, logs, `eridani-runs.json`, the registry, the
  journal, the outbox or the status file.

**Readiness upstream.** When the key file is missing or invalid, or the URL
cannot be formed, the agent is still spawned, but without the server. Eridani
is told:

- in the spawn's `command.outcome.result`: `mcp: {configured: boolean,
  reason?: string}`, e.g. `{configured: false, reason: "no MCP key file at
  /home/davin/.config/remotea/eridani-mcp-token"}`. The same field is on the
  binding, so a replayed or "already started" spawn reports it too;
- in each `hello` target: `mcp: {configured, reason?}`, checked at hello time.

Both fields are optional; an older host omits them. The SessionStart context
of a run's surface ends with one line: either `Eridani tools: submit_plan,
submit_plan_review, task_step, task_interview, session_link are available via
the eridani MCP server.`, or that they are not available and why. `remotea eridani targets
list` prints each target's MCP state.

**Trust boundary.** Nothing Eridani sends becomes a program, a path or a shell
word, apart from three validated values: the model name
(`MODEL_RE`: letters, digits and `._:/@[]-`, at most 80), the branch (git ref rules), and the
prompt. The prompt is passed in `$ERIDANI_PROMPT` and expanded by the login
shell as **one argv word**; it is never parsed as shell text, and a prompt
starting with `-` is refused. `env` accepts only `ERIDANI_*` keys with
one-line values. This is policy against Eridani's text becoming commands. It
is not a sandbox: the agent itself runs with `--permission-mode auto` as you
(a spawn with `mode` runs read-only instead; see [Roles and read-only
modes](#roles-and-read-only-modes-hyperplan)).
Stage F tightened `input`, the lost-run respawn and verify. See
[Stage F: security model](#stage-f-security-model).

### Worktrees

One worktree per branch under the target's `worktreeRoot`
(`eri/task-1` → `<root>/eri--task-1`): reused when it exists, created from the
base otherwise (`git worktree add -b <branch> <path> <base sha>`), and the base
is recorded in `eridani-worktrees.json`. A spawn on the base branch itself is
refused. Operations on one repo run one at a time.

**One writer per worktree (S-S4).** Every Eridani session that has not exited
(live, or lost and about to be resumed) is the *writer* of its branch's
worktree. A spawn onto a branch that already has a writer, or that another
spawn in flight is claiming, is refused before anything starts:
`command.outcome {state: "rejected", detail: "worktree_busy", result: {branch,
writer: {surf, run_id}}}`. That holds for another attempt of the same run
too: stop the old surface first. A spawn that says `share: true` starts
anyway, in the same worktree, and both sessions edit it (the oldest stays the
reported writer). A child task's spawn names its own branch with the parent's
branch as `base`, so it gets its own worktree as before, while the parent
keeps writing. A read-only spawn (hyperplan `mode`, see [Roles and read-only
modes](#roles-and-read-only-modes-hyperplan)) is not a writer: it starts
beside the writer without `share`, claims nothing, and does not make a later
writable spawn `worktree_busy`; it still counts toward `limits.maxRuns`. The
worktrees report's `writer` is unchanged: the oldest live session there,
read-only or not.

**Freshness.** Before basing on (or reusing a worktree of) the target's own
`base`, the host runs `git fetch origin <base>` (30 s, non-interactive). New
work starts from `origin/<base>`, unless local `<base>` already contains it
(unpushed local commits), in which case local wins. When the fetch fails the
host keeps the local branch and the prompt begins: "Could not fetch
origin/<base> (<reason>); this worktree is based on local <base> @ <sha>,
which may be stale." A reused branch that is behind the fresh base gets
"Your branch … is N commit(s) behind origin/<base>. Before touching code,
merge origin/<base> into it …" at the top of its prompt, and, when the spawn
carries a reserved `migration`, the instruction to re-point its
`down_revision` at the current chain head and renumber it if taken. A tag, a
commit or a parent branch as base is never fetched. The spawn outcome adds
`base_ref, fetch {ok, error?}, behind, ahead`.

**Migrations.** A target may say where its numbered migrations live:
`"migrations": {"dir": "migrations/versions", "pattern": "^(\\d{4})_"}`
(pattern optional, first capture group is the number). hello lists it on the
target, and `worktrees.report` adds `heads [{target, dir, ref, head}]`: the
highest number in `dir` on the fresh base ref. Eridani reserves the next
number when it freezes a plan that adds a migration. The directory is host
configuration (like `verify`), so nothing Eridani sends becomes a path.

remotea **never removes a worktree**. `remotea eridani worktrees` (and the
`worktrees.report` frame) lists each with why removing it would lose work:
in use by a live session, locked, uncommitted / untracked / ignored files
(an unforced `git worktree remove` deletes ignored files such as `.env`), not
merged into its base, unpushed or no upstream, detached. Rows on the target's
own base are measured against `origin/<base>` (`base_ref`), fetched at most
every 5 min. A branch with no commits of its own reports `merged: null` with
`merged_reason: "no commits of its own yet"`, not `true`. A row with no reason
is a *candidate*, and the CLI prints the commands a person could run: a
recovery ref first (`refs/remotea/recovery/<branch>`), then
`git worktree remove`. Each row also carries `writer: {surf, run_id} | null`
(S-S4, optional: older hosts omit it), the live session writing that
worktree, so "unmerged work" can say who is still on it; the CLI prints it as
`writer <surf> (run <run_id>)`.

**To the desktop app (additive).** After each successful worktree scan, every
Eridani session whose worktree was scanned gets `worktreeState {uncommitted,
untracked, ahead, merged, unpushed, baseRef, at}` on its `SessionRecord` in the
app protocol (`src/shared/remote-host-protocol.ts`), pushed with the next
registry update only when it changed. `ahead`, `merged` and `unpushed` are
null when unknown. The app's recovery dialog uses it to say what an ended
run left behind ("2 uncommitted changes, not merged into origin/main"). It is
only refreshed while the Eridani link is ready (scans run then). An app
without the field ignores it; a server without it leaves the dialog showing
exits and closes only, without worktree items. Nothing on the Eridani wire
changes.

### Commands

| `t` | Fields | Effect |
|---|---|---|
| `spawn` | `run_id, generation, attempt, harness, model, target {id, repo?, branch, base?}, task_id?, title?, group?, prompt, env?, run_token?, verify? {verify_id, plan_revision}, migration? {number, dir}, share?, role?, mode?, resume_session_id?, expires_at` | `resume_session_id` (optional, cap `spawn.resume`): continue an earlier Claude conversation, see [Restart run](#restart-run-spawnresume); the outcome's `result` then carries `resumed`. `share` (boolean, optional, S-S4): start even when another live session writes the branch's worktree; without it such a spawn is `rejected` `worktree_busy` with `result {branch, writer {surf, run_id}}` (see [Worktrees](#worktrees)). `role` (`planner` \| `reviewer` \| `worker`, optional; absent = planner) and `mode` (`plan` \| `review`, optional; absent = writable): hyperplan, see [Roles and read-only modes](#roles-and-read-only-modes-hyperplan); with `mode` the launch below is the read-only one, the outcome's `result` carries `role` and `mode` back, and a harness without a read-only launch is `rejected` `mode_unsupported`. Ensures the worktree and opens a session in it, device "Eridani", in the named group (default "Eridani"). Claude: `claude [--mcp-config <file>] --model <m> --permission-mode auto "$ERIDANI_PROMPT"`. Codex: `codex [-c mcp_servers.eridani.…] --disable daemon_auto_start -m <m> "$ERIDANI_PROMPT"` (see [Eridani MCP](#eridani-mcp-for-spawned-agents)). The outcome's `result` carries `mcp {configured, reason?}`. The surface id is derived from `(run_id, generation, attempt)`: the same spawn never starts two processes. S-Q3 ([Target templates](#target-templates-s-q3)): a target whose template fails is `rejected` `target_not_ready: <reasons>` with `result {template}`; one at `limits.maxRuns` is `rejected` `target_busy` with `result {limit, running}`; with `prepare` steps the worktree is prepared first and `result.prepare` is `{ran, ok, steps: [{id, exit_code, duration_ms, timed_out?, error?}], reason?, log?, tail?}` (`ran: false`: an earlier preparation of the same steps still holds); a failed preparation is `failed` `prepare: <reason>` with `result {worktree, branch, target, prepare}` (with `tail`, the last 2,000 characters of output) and no agent starts. |
| `input` | `surf, incarnation, run_id, generation, mode: queue\|steer, text, expires_at` | `text` may contain no control character except newline and tab, and may not start with `/` or `!` (stage F). `queue` waits until the agent is idle at its prompt **and** the link is up; `steer` advances the binding's generation first, sends Esc, then (800 ms later) the text. Typed as a bracketed paste and Enter (150 ms later). Never counts as a person answering. The outcome is `executed` only once Enter was sent; see [Input and steer outcomes](#input-and-steer-outcomes). |
| `stop` | `surf, incarnation, run_id, generation, mode: interrupt\|kill` | `stopRequested` is persisted on the session before anything is sent, and cleared only when the exit is seen. `interrupt`: Ctrl-C twice, and again after 1.5 s; if the process is still there after 20 s the outcome is `failed` ("send mode:kill") and the stop stays requested. `kill`: the process tree. A run with a requested stop is never resumed. |
| `answer` | `question_id, provider_request_id, answers [{item_id, choice_ids?, text?}]` | See [Questions](#questions-claude). |
| `run.reopen` | `surf, incarnation, run_id, generation, expires_at` (Eridani gives it 5 min) | Eridani's "Reopen terminal" for a run whose agent exited: sent only to a host whose hello `caps` has `run.reopen`. `incarnation` is the one that exited. The host respawns that surface **in place**, the way recovery on boot (below) respawns a lost one: the same `surf`, binding, `eridani-runs.json` env (run token included), MCP arguments and verify config, the resume line (`claude --resume <id> …`, a managed run through its managed resume), as the next incarnation. No prompt is typed: the agent waits at its prompt, and (M7) input waits for its new SessionStart. `executed` with `result {surf, incarnation: <the new one>}`. A reopen that already happened (the surface is live at a newer incarnation) is `executed` again with the current facts and starts nothing. `rejected` with `detail`: `unknown surface` (no record: closed, or pruned after `exitedRetentionMs`), `run does not match`, `stale generation` (not the binding's generation), `not the run's worker` (a reviewer), `a stop was requested`, `the surface is still running` (live at that incarnation), `stale incarnation`, `resuming agents is turned off`, `no conversation to resume` (no agent session was ever reported). `failed` `reopen: <reason>` when the respawn does not start (`the run could not be resumed` when no resume line can be built, or the spawn error); the surface then stays exited exactly as it was (D4: never a bare shell holding the binding) and no second `exit` is sent. Apps showing the dead terminal are handed the new process (an `opened` with `wasLost`). Found `executing` after a restart it settles as `executed` when the surface moved on to a newer incarnation, else `failed`. |
| `verify` | `attempt_id, run_id, generation, turn_seq, plan_revision, verify_id, expires_at` | Runs one of the target's `verify` entries in the run's worktree (fixed argv, no shell, a minimal environment, the target's timeout), then sends `verify.result`. Shares the attempt machinery of [stage D](#stage-d-verification-after-turns). |
| `terminal.focus` | `surf, run_id, generation, expires_at` (Eridani gives it 30 s) | Eridani's "Open terminal in remotea": sent only to a host whose hello `caps` has `terminal.focus`. The hub sends `{t: "focus", id: surf, runId}` to every connected app whose hello listed the `focus` feature and that has not hidden the session; the app raises its window and selects the tab. `executed` with `result {desktops: <how many apps were told>}`; `rejected` `no_desktop` when none was (no app connected, only older apps, or every app hid the tab), so Eridani shows where the terminal is instead; `rejected` `unknown_surf` when the surface is gone, exited, or not bound to `run_id`. The generation is informational (a stale one is harmless). `expires_at` is required. Journaled like every command; found `executing` after a restart it settles as `failed`. See [Open in Eridani](#open-in-eridani-and-the-terminal-from-eridani). |
| `worktrees.scan` | `run_id, generation, branch, turn_seq, tool?, session_id?, expires_at` (Eridani gives it 2 min) | The judge's PR evidence (Eridani PR #94): sent only to a host whose hello `caps` has `worktrees.scan`, while a judge verdict waits for a PR record newer than the turn. Rescans the worktrees and sends `worktrees.report` **even if nothing changed**; when `tool` and `session_id` are given (both or neither), re-reads that session with the collector and sends its `session.report` even if its fingerprint is unchanged. Then `executed` with `result {worktrees: "reported", session?: "reported" \| "not_found" \| "collector_off"}`; `failed` (with the reason) when a scan fails or the outbox refuses a report. The run fence is informational: a stale `run_id`/`generation` is harmless and not rejected, but `expires_at` is required and a past one is `rejected` ("expired"). Journaled like every command (refused with `journal_unavailable` when the journal cannot record it); found `executing` after a restart it settles as `failed`. |
| `ci.status` | `run_id, generation, branch, turn_seq?, log_lines?, target?, expires_at` (Eridani polls every 2 min) | GitHub CI as the run's final verification: sent only to a host whose hello `caps` has `ci.status`. Read-only, with the host's logged-in `gh` (no shell) in the branch's worktree (a target's `<worktreeRoot>/<branchDir>`, else the folder of a live session bound to the run, else the repository of execution target `target`, for a run whose worktree was cleaned up): `gh pr view <branch> --json number,url,headRefOid,state,baseRefName,isDraft,mergeable,mergeStateStatus`, `gh pr checks <branch> --json name,state,bucket,link,workflow,startedAt,completedAt` (exit 1 or 8 still prints the JSON; "no checks reported" is an empty list), and, when `log_lines` (0..200) is above 0, `gh run view <run> --job <job> --log-failed` for up to 3 failed Actions jobs, even while other checks are still running: the last `log_lines` lines, ANSI codes and `gh`'s line prefixes stripped, [redacted](redaction.md). Then `git rev-parse HEAD` in the worktree. `executed` with `result {pr: {number, url, head_sha, state, base, draft, mergeable, merge_state} \| null, checks: [...], failed_logs: [{name, link, lines}], worktree_head}`; a log not available yet is left out (Eridani asks again). `failed` with the reason when `gh` is not installed or not logged in (`gh auth login` on the host), or there is no worktree for the branch here. The branch must not start with `-` or contain `..`. Like `worktrees.scan`, the fence is informational and `expires_at` is required; found `executing` after a restart it settles as `failed`. |
| `run.changes` | `run_id, generation, branch, base?, turn_seq?, max_chars?, target?, expires_at` | What the run changed, as evidence for Eridani's judge: sent only to a host whose hello `caps` has `run.changes`. Read-only, with `git` (no shell) in the branch's worktree under execution target `target` (any target's when none is named), else the folder of a live session bound to the run; never the target's own repository, which is another checkout. The base is `origin/<base>` when the clone has it, else the local `<base>` (`base` defaults to the target's base branch); the comparison point is `git merge-base HEAD <base>`. `executed` with `result {head, base_ref, base_sha, files: [{path, added, removed}], files_total, untracked, untracked_total, uncommitted, patch, patch_truncated, patch_chars}`: `files` is `git diff --numstat -M` of the working tree against that point (at most 300; binary files have null counts), so uncommitted edits count; `untracked` names new files git does not track yet (at most 100), which are in neither `files` nor `patch`; `patch` is `git diff -M` without lock files (`package-lock.json`, `uv.lock`, ...), [redacted](redaction.md), cut at `max_chars` (1,000..200,000, default 60,000). `failed` with the reason when there is no worktree for the branch here, git is missing, the folder is no repository, or the base branch is unknown. Like `ci.status`, the fence is informational and `expires_at` is required; found `executing` after a restart it settles as `failed`. |
| `pr.merge` | `run_id, generation, branch, head_sha, target?, origin?, expires_at` (Eridani gives it a few minutes) | Eridani's Merge button and auto-merge: sent only to a host whose hello `caps` has `pr.merge`. With the host's logged-in `gh`, in the branch's worktree, else a live session's folder, else the repository of execution target `target` (a merge after the run's worktree was cleaned up). Reads the pull request first: already `MERGED` is `executed` with `already: true` (a retry is safe); `CLOSED`, none, or a head other than `head_sha` is refused before merging. Then `gh pr merge <number> --merge --match-head-commit <head_sha>` (never `--delete-branch`) and reads the pull request back. `executed` with `result {merged: true, already, pr, merge_commit}`; `rejected` with `detail` = the reason (`behind` its base, `conflicts`, `head_moved`, `blocked` by a rule or a required check, `draft`, `not_open`, `no_pr`, `permission`) and `result {reason, message, pr}`; `failed` when `gh` is missing or logged out or there is no clone of the repository here. `head_sha` is a full 40-hex sha. Found `executing` after a restart it settles as `uncertain` (Eridani reads the pull request again with `ci.status`). |
| `pr.update_branch` | `run_id, generation, branch, head_sha, target?, origin?, expires_at` | Eridani's Update branch (a pull request behind its base under a strict "up to date" rule): sent only to a host whose hello `caps` has `pr.update_branch`. `gh api -X PUT repos/{owner}/{repo}/pulls/<n>/update-branch -f expected_head_sha=<head_sha>` (GitHub merges the base into the head on its side; gh 2.45 has no `gh pr update-branch`). The host then waits up to ~10 s for the new head and, when the run's worktree is clean and still on `head_sha`, fast-forwards it so the agent's next push is not refused. `executed` with `result {updated: true, pr_number, base, new_head_sha (null if GitHub had not made it yet), worktree_synced}`; `rejected` like `pr.merge` (`head_moved`, `conflicts`, `permission`, `not_open`, `no_pr`, `blocked`). Found `executing` after a restart it settles as `uncertain`. |
| `target.setup` | `repo, target_id, harness, model, confirm, target?, expires_at` (not run-bound) | Eridani's "add a target", without a terminal: sent only to a host whose hello `caps` has `target.setup` (every host from this build on, with or without the sandbox). The [guided target setup](#execution-targets) run for Eridani, through the CLI's own code (`remote-server/src/eridani-target-command.ts`). `repo` is an absolute path on the host (≤ 1000 characters); `target_id` (not `id`: that is the frame's own id) is the target id, or null to derive it as the CLI does; `harness` (`claude`, `codex` or null) and `model` choose who reads the repository. **`confirm: false`** proposes only, as `targets setup <repo> --json`: a harness reads the repository read-only (or the heuristics answer), CI is read, no proposed check runs, nothing is written; `executed` with `result` = the `--json` object (checks `not_run` with `needs_confirmation`). **`confirm: true`** carries `target`, the proposal's `target` as that outcome returned it, after a person saw it and said yes. No harness is asked again (a second reading could differ from what was shown). The target is checked as `targets add` checks one and as a harness's answer is checked (no shell strings, `cwd` inside the repository, at most 4 checks), its `repo` must be the same repository as `repo` (symlinks resolved), and its verify and prepare entries may carry only `id, argv, cwd, timeout`: one that sets `env`, `isolation`, `network`, `ports`, `mounts` or `notifyAfter` is refused. `launch`, `worktreeRoot`, `mcpKeyFile`, `limits` and `migrations` come from the host (the existing target with that id, else the defaults the proposal used), never from the command. Each verify entry then runs once in the verify sandbox with no network, the passing ones are kept, the target is saved (replacing one with the same id), the host probes any new launcher and sends a new hello, so the target is listed before the outcome arrives: `executed` with the same object, `saved: true`, `source: "confirmed"`, `harness {asked: null, version: null, model: null}`. Output tails, reasons and notes are [redacted](redaction.md). Refused at acceptance (`rejected`) when another setup is running on the host (one at a time), the folder is missing or not a git repository, or the target is invalid or for another repository; `failed` when a confirm has a check to try and the sandbox does not work here (with its reason; a confirm without a check runs nothing and is saved), when the id belongs to another repository, or when a confirm's checks ran past `expires_at` (nothing saved). Accepted at once, reported when done (a harness read takes minutes, a check up to 10). Not durable: found `executing` after a restart a proposal settles as `failed` and a confirm as `uncertain` (it saves last; the next hello says whether it did). |

Every command (except `worktrees.scan`, `ci.status` and `run.changes`, which only read, `terminal.focus`, which only raises a tab, and `pr.merge` / `pr.update_branch`, which act on GitHub and are fenced by `head_sha` instead, and `target.setup`, which belongs to no run) needs a fence that matches: an `input`/`stop`/`run.reopen` names the surface
and its `incarnation`, the run, and the generation (a queued input and a
reopen must match the current generation; steer and stop may name a newer one). Every effectful
command (`spawn`, `input`, `answer`, `stop`, `verify`, `run.reopen`) must carry
`expires_at`, and so must `worktrees.scan`, `ci.status`, `run.changes`, `pr.merge`, `pr.update_branch`, `terminal.focus` and `target.setup`. A missing one is rejected (`expires_at required`, since stage
F), and so is one that is past or more than 7 days out (the replay horizon,
the time the journal remembers an `op_id`).

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
  (the process ended with the server) or, when the PTY keeper kept the
  process, as `failed` ("interrupted by a server restart; the process
  outlived it…": the stop stays requested and boot sends it again), a
  `verify` as `failed`, a `run.reopen` as `executed` when its surface is
  at a newer incarnation (else `failed`); an `input` or
  `answer` becomes `uncertain`, since its bytes may or may not have arrived;
- a duplicate `op_id` gets its recorded outcome, never a second run.

**When the journal cannot be written** (disk full, an I/O or sync error, a
permission change, a failed rewrite). Everything above relies on what the
journal says being on disk, so:

- A state change is appended and fdatasynced first, and only then does the
  server's memory of the op change. A failed write is cut back off the file
  (best effort), leaves memory as it was, and marks the journal degraded. A
  duplicate, `replayAccepted` and the reconnect snapshot
  (`journal {pending, uncertain}`) therefore only ever see durable states.
- While the journal cannot record a command's first state, the command is
  refused with `ack {ok: false, error: "journal_unavailable", outcome:
  {state: "rejected", detail: "journal_unavailable", durable: false}}`. Nothing
  is journaled, nothing runs, and no `command.outcome` follows. Eridani treats
  it as a final refusal ("refused by the host: journal_unavailable"); the
  `op_id` is not remembered, so a resend is judged afresh. This holds for
  rejections too: a refusal that cannot be recorded is never acked as a
  recorded `rejected`.
- If `executing` cannot be recorded, the handler is stopped before its
  effect (the `begin()` it calls throws) and the command's outcome is
  `failed` ("journal_unavailable: not started"). If the final outcome cannot
  be recorded, the effect has happened but nothing is reported. Either way
  the outcome waits in memory and the journal keeps saying
  `accepted`/`executing`. Once the journal can be written again the outcome
  is recorded, then sent as `command.outcome`. A restart before that settles
  the op from what is on disk (an `accepted` one is re-run, an `executing`
  one goes through `recover` or becomes `uncertain`), never from memory.
- Settlements a restart makes (`executing` → settled or `uncertain`) reach
  memory and are reported only once they are written. A journal that exists
  but cannot be read is never overwritten: commands are refused until it can
  be read, and then it is merged.
- After a failed write the file may hold a torn or unsynced line, so the next
  write first rewrites the whole journal from memory (temp file, fsync,
  rename). The first write that succeeds clears the degradation. That is the
  next command Eridani sends, or a probe every 30 s while degraded. A
  compaction that fails while the journal is healthy changes nothing, since
  every appended line is already synced.
- The terminals are not affected. The hub and every PTY keep running, and
  people keep typing; only Eridani's effectful commands are refused. Every
  asynchronous entry into command handling (each inbound frame, each replay,
  and dispatch's timers such as a queued input starting) catches and logs
  instead of letting an exception or a rejected promise reach the process.
- The link reports it. `eridani-status.json` (`remotea eridani status`) has
  `degraded: "journal_unavailable (<stage> failed: <code>)"`, where stage is
  `open`, `write`, `sync`, `compaction` or `read`, and
  `journal {degraded, unrecorded, refused}`. The CLI prints a `journal
  DEGRADED` line. The next `hello` carries the same text as
  `degraded_reason` (see below).

**Recovery on boot.** Eridani sessions the restart lost are respawned with
their conversation (`claude --resume <id> --model <m> --permission-mode auto`,
`codex resume --disable daemon_auto_start -m <m> <id>`; a session spawned with
a read-only `mode` resumes with that mode's flags), with the run's env
from `eridani-runs.json` (0600; the run token and env never go into the
registry). A lost session whose stop was requested is marked exited instead.
So is one that cannot be resumed: no conversation was ever reported, or
`resumeAgents` is off (stage F, D4). Such a session is reported upstream as
`exit {code: -1, reason}` and is never respawned as a bare shell. That rule
holds whether the server notices it on boot or an app reopens the tab. To get
a shell there, open a new tab in the worktree yourself. It is not bound to the
run. This happens whether or not the link is enabled. An exited run surface
can be resumed in place the same way later, on Eridani's request
([`run.reopen`](#commands)).

A session whose process the PTY keeper kept ([upgrade.md](upgrade.md), off by
default) was not lost: it is adopted before anything else runs and stays
`live` with the **same incarnation**, binding, generation and turn numbering,
so the new boot's `sessions.snapshot` reports it exactly as the old one did
(only `boot_id` in hello changes). Dispatch still vouches for its agent (M7):
the launch record is mirrored to `eridani-launched.json` and read back only
for a kept process in the same incarnation. A kept session with a stop
requested is stopped again on boot. One that exited while no server ran is
reported as a normal `exit` with its code.

#### Draining for a restart

`remotea upgrade` (S-Q5) asks the server to drain (SIGUSR2) before it
restarts it. While draining:

- commands are still journaled and acked `accepted`, but not run; the next
  boot replays them after its `runs.snapshot`, with every fence checked again
  then (the usual path for `accepted` commands after a restart);
- no queued `input` starts; a steer or input already typing finishes;
- the server waits (up to `--timeout`, 30 s) until no command that called
  `begin()` is unsettled and no steer or input write is pending, then the
  CLI restarts the unit;
- the link says so: hello carries `draining: true`, and an Eridani whose
  welcome advertised `draining` gets `host.state {draining: true, reason:
  "restart"}` at once (and `{draining: false}` if the drain is abandoned).
  An Eridani that does not advertise it is sent nothing new and sees a short
  disconnect.

A drain that no restart follows expires after its timeout plus 60 s: the
server stops draining and runs what it held.

**runs.snapshot** (Eridani → remotea, after welcome, chunked like the
snapshot): `runs [{run_id, generation, desired: continue|stop|none,
stop_mode?, verify? {verify_id, plan_revision} | null, surf?, attempt?}]`. A newer generation is adopted (an older queued input is then
refused, and a steer or input still waiting to type is canceled);
`desired: stop` is carried out like a stop command. An entry is applied per
surface (hyperplan): with `surf` to that surface only, with `attempt` (and no
`surf`) to the run's session of that attempt, and with neither to every
session of the run, as before. A run with more than one live session (a
reviewer beside its planner) gets one entry per surface, so stopping the
reviewer leaves the planner alone.

#### Input and steer outcomes

A steer is three writes with two delays: Esc, 800 ms, the bracketed paste,
150 ms, Enter. A queued input is the last two (paste, 150 ms, Enter), typed
once the agent is idle and the link is up. Each is one pending write per
surface, and both delays belong to it: the handler does not return until Enter
was sent or the write was canceled. (Before S-N1 the Enter was a detached
timer, and a steer only checked that the process was alive after its Esc
delay, so a steer at generation 2 could be pasted and submitted after
runs.snapshot had stopped the run at generation 3, and still report
`executed`.)

Immediately before **every** byte (Esc, the paste, Enter) the write is fenced
again. It must still find:

- the same run on the surface, in the same generation;
- the same process incarnation, still running;
- no `stopRequested`;
- the run's agent present in that incarnation (stage F, M7);
- the link up, and not reconnected since the write began.

These cancel a pending write at once (its delay is woken, its timer cleared):

- a `stop` command, or a runs.snapshot `desired: stop`;
- a newer steer on the surface (it also cancels a queued input waiting for
  its Enter);
- a runs.snapshot that adopts a newer generation;
- the process exiting, or being respawned;
- the link becoming ready again. A reconnect is followed by Eridani's
  runs.snapshot, the reconcile; a write begun before it is never resumed.
  Eridani decides again.

A steer is also re-fenced when its handler starts, so a steer accepted before
the run moved on is `rejected` before any byte.

Outcomes, through the usual `command.outcome`:

| What happened | `state` | `result` |
|---|---|---|
| Enter was sent | `executed` | `{mode, generation}` |
| canceled or fenced out once the write began | `failed` | `{mode, generation, outcome: "interrupted", reason, written: {escape, text, enter}}` |
| refused before anything was written | `rejected` | none (`detail` says why) |

The `detail` of an interrupted write says what was and was not sent, for
example `interrupted: a stop was requested. Esc and the text were sent; Enter
was not, so the text was not submitted (it may still sit in the agent's
input).` The wire state stays `failed`: Eridani's `command.outcome` accepts
only `executed | failed | rejected | uncertain`, so "interrupted" travels in
`result.outcome`. Nothing was submitted, so it is not `uncertain`. When a
newer steer cancels an older one between its paste and its Enter, the older
text can stay in the agent's input box and be submitted together with the newer
steer's text. Clearing the input box would need an agent-specific key
sequence.

A restart while an `input` is `executing` still settles it as `uncertain`
(see **Journal** above): the bytes may or may not have arrived.

### Roles and read-only modes (hyperplan)

Hyperplan runs more than one session per run: a **planner** drafts the plan,
a fresh **reviewer** reads it (and the repo) each round, and a **worker**
executes the approved plan (or the planner's session continues into
execution, which is today's run). The host's part is small and additive;
the loop itself lives in Eridani (`docs/AGENT_CONTROL.md`, "Hyperplan and
roles"). hello `caps` advertises `spawn.roles` for all of this (with the
stage F caps, in both collector modes); Eridani refuses hyperplan or a split
worker on a host without it.

**`spawn.role`** (`planner` | `reviewer` | `worker`; absent = `planner`) is
recorded on the session's binding (`eridani.role`, so it survives a restart)
and echoed in the spawn outcome's `result.role`, the spawn `facts` and the
agent's `ERIDANI_ROLE`. Its one effect on the host: `verify` (command and
auto) binds to the run's newest session that is **not** a reviewer (the
planner, then the worker), so a review session never gets verified or
chosen as "the run's session". A run whose only sessions are reviewers has
no bound session (`verify` is `rejected` `unknown run`).

**`spawn.mode`** (`plan` | `review`; absent = writable, today's launch) starts
the harness read-only, recorded as `eridani.mode` and `ERIDANI_MODE`, and
kept by a resume after a restart:

| Harness | Writable (no `mode`) | Read-only (`mode` set) |
|---|---|---|
| Claude (2.1.x) | `claude [--mcp-config <file>] --model <m> --permission-mode auto [args] "$ERIDANI_PROMPT"` | `claude [--mcp-config <file>] --allowedTools 'Read' 'Grep' 'Glob' 'Bash(git status *)' 'Bash(git log *)' 'Bash(git diff *)' 'Bash(git show *)' 'Bash(ls *)' 'Bash(cat *)' 'Bash(rg *)' 'mcp__eridani__*' --disallowedTools 'Edit' 'Write' 'NotebookEdit' --model <m> --permission-mode dontAsk [args] "$ERIDANI_PROMPT"` |
| Codex (0.166) | `codex [-c …] --disable daemon_auto_start -m <m> [args] "$ERIDANI_PROMPT"` | `codex [-c …] --disable daemon_auto_start -m <m> --sandbox read-only --ask-for-approval never [args] "$ERIDANI_PROMPT"` |

`dontAsk` denies every tool outside the allow list without a prompt, so
nothing waits on a terminal dialog that remotea does not relay (that is why
Claude's own plan mode is not used: leaving it asks in the terminal). The
MCP entry names the server remotea registers (`eridani`, eridani-mcp.ts), so
`submit_plan`, `submit_plan_review` and `task_interview` work; the roles'
prompts ask through `task_interview`, never AskUserQuestion (denied). Both
Claude lists take several values, so they go before `--model`, which ends
them: the prompt is never read as a tool name. `codex resume` accepts the
same two flags. A `mode` on a harness with no read-only launch is `rejected`
`mode_unsupported` with `result {harness, mode}`; it is never started
writable. The lines without `mode` are byte-for-byte what they were.

A read-only spawn is **not a writer** ([Worktrees](#worktrees)): it starts in
the live writer's worktree without `share` (Eridani sends `share: true`
anyway), claims nothing, and does not block the writable spawn that follows
it (the worker at handoff), while still counting toward `limits.maxRuns`.
`runs.snapshot` entries name the surface they are for (`surf`, or
`attempt`), so a `desired: stop` for the reviewer leaves the planner alone
([Draining for a restart](#draining-for-a-restart) has the entry shape).

What this is not: Bash allow rules match the command text and are not a
security boundary, Codex's sandbox is the harness's own, and the worktree is
shared with the writer, so what a reviewer can read is bounded by the same
git-ignore hygiene as the planner's. `status` frames already carry
`effective_permission_mode`. Live use of a new build needs the service
rebuilt and restarted (`remotea upgrade`).

### Restart run (`spawn.resume`)

Eridani's "Restart run" continues a finished run as a new run on the same
task, branch and worktree. Where it can, the new run's agent continues the old
run's Claude conversation, so it remembers the earlier work. hello `caps`
advertises `spawn.resume` (every host, beside the other stage F caps), and
only then does Eridani add `resume_session_id` to the new run's `spawn`: the
old run's Claude session id. An Eridani that never sends it gets the same
host as before; a host without the cap never receives it.

- **Shape.** The id must match `[A-Za-z0-9._:-]{1,128}`, the ids a resume line
  takes; anything else is `rejected` `bad resume_session_id`.
- **Where the conversation is looked for.** The spawn ensures the worktree as
  any spawn does (same branch, same path). Claude finds a conversation by
  working directory, so the host then looks for
  `<claude config>/projects/<folder>/<id>.jsonl`, where `<claude config>` is
  `$CLAUDE_CONFIG_DIR` or `~/.claude` (of the remotea service) and `<folder>`
  is the worktree path with every character other than a letter or digit made
  `-`. A folder name over 200 characters is matched by its first 200 plus `-`
  (Claude adds a hash there that differs between builds). The worktree's path
  and its real path are both tried.
- **Found.** The agent starts with the line boot recovery resumes with
  (`claude --resume <id> … --model <m> [--effort <e>] --permission-mode auto`,
  read-only with `mode`) followed by `"$ERIDANI_PROMPT"`, so the spawn's
  prompt is its first message. An empty prompt appends nothing and the
  resumed agent waits at its prompt. The record's `agent` is set to the
  resumed id at once (a restart of the server before the agent's first hook
  can still resume it).
- **Not found, or not Claude.** The spawn starts fresh exactly as without the
  field. A Codex (or other non-Claude) spawn ignores the field.
- **Managed runs.** The id goes to the managed adapter, which launches
  `claude -p … --resume <id>` and then sends the prompt (none when it is
  empty). A managed Codex run starts fresh.
- **Outcome.** Every `spawn` that carried the field reports
  `result.resumed: true | false` in its `executed` outcome (also on a replay
  and after a restart); a spawn without it has no `resumed`.

The binding, run token, secrets and MCP config are new, as for any spawn: it
is a new run that happens to share a conversation.

### Open in Eridani, and the terminal from Eridani

Both directions between a run's terminal tab and its page in Eridani (roadmap
task 03ff84bf).

**From the tab to Eridani.** A spawn's binding (`SessionRecord.eridani`, which
every app receives in `welcome`, `sessionAdded` and `sessionUpdated`) carries,
besides `runId`, `taskId` and `generation`:

| Field | From | |
|---|---|---|
| `webUrl` | `eridani.json` `webUrl`, else derived from the link `url` | Eridani's web app (origin and path, no trailing slash). Absent when neither gives an http(s) URL. Bindings recorded before this field existed are filled in when the link is (re)configured; one that has it is never changed. |
| `taskTitle` | the spawn's `title` | Absent when the spawn carried none. |

No secret is in it. The app shows a small ↗ button on such a tab and, in the
tab's context menu, **Open in Eridani** (the system browser, through
`shell.openExternal`) and **Copy run link**. The link is
`<webUrl>/?view=remotea&run=<runId>`, Eridani's existing deep link to the run
panel (`src/shared/eridani-deep-link.ts`). The app builds it only from an
`http:`/`https:` URL without credentials and a plain run id; anything else
shows no link, and the main process refuses any other scheme as well. An
older server sends no `webUrl`: the tab simply has no link.

**From Eridani to the tab.** `terminal.focus` (see [Commands](#commands)).
App ↔ server, additively:

- The app's `hello` may carry `features: ["focus"]` (an app that can raise a
  tab). An older server ignores the field; a newer server ignores names it
  does not know.
- `welcome.features` lists `focus` (this server may send it).
- `{t: "focus", id, runId?}` goes only to apps that listed `focus`; an
  older app never gets it (it would drop it anyway: unknown types are
  ignored), which is why the host answers `no_desktop` when only older apps
  are connected.

The app raises the window that shows the tab (restoring a minimized one) and
selects the tab; if no window shows it yet, it raises the main window.

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
(`permission: "capture"` in `harnesses`). A question is held only while
`harnesses.claude.question_kinds` includes `ask` (the tested version range,
and the AskUserQuestion hook installed with its 600 s timeout); otherwise the
helper is told `not-verified` and Claude asks in the terminal at once.

### Approvals (Codex)

Codex CLI's approval prompt is answered through its `PermissionRequest` hook,
which remotea installs in `~/.codex/hooks.json` with a 600 s timeout (every
other Codex entry keeps 10 s). For a session bound to a run, with the link
up and the adapter advertised (`harnesses.codex.question_kinds` includes
`approval`):

1. the helper (`--event PermissionRequest --provider codex`) holds
   `remotea.approval` on the bridge, and the TUI shows "Running hook" (no
   prompt). The server sends `question {…, provider: "codex", kind:
   "approval", provider_request_id, provider_turn_id (turn_id), items: [{id:
   "q1", header: "Approval", text: "Codex wants to run:\n<command>[\nReason:
   …]", choices: [{id: "allow_once", label: "Allow once"}, {id: "deny",
   label: "Deny"}]}]}` and the pane says needs_you. PermissionRequest has no
   `tool_use_id`; `provider_request_id` is the `tool_use_id` of the
   PreToolUse Codex fires just before it for the same tool, else
   `perm_<uuid>`;
2. the `answer` takes exactly one choice; a `text` note goes with `deny` only
   and becomes the message the model gets (default "Denied from Eridani.").
   The helper prints `{"hookSpecificOutput": {"hookEventName":
   "PermissionRequest", "decision": {"behavior": "allow"}}}` or `{…
   "behavior": "deny", "message": "…"}`. There is no "always": Codex 0.166
   fails closed on `updatedPermissions`, so "don't ask again" stays a
   terminal choice;
3. `question.resolved accepted` on the call's PostToolUse (allowed), or when
   the turn moves on after the decision (Stop, a new prompt, the next
   approval): a denied call never runs, so it has no PostToolUse.

Otherwise the helper prints nothing and reports the permission Notification
as before, and Codex shows its own prompt ("Would you like to run the
following command?"): not an Eridani session, link down, a subagent's
request, the adapter not advertised (`not-verified`), or the 570 s hold
expired (`timed_out`, still open; the call running or the turn ending then →
`answered_locally`; a new prompt → `canceled`). Esc while the hook holds
interrupts the whole Codex turn and kills the hook → `canceled`. While an
approval is held no hook event resolves it (a background tool finishing, a
subagent's Stop and the like are ignored); only an answer, the timeout, the
hook dying or the process exiting end it.

Codex 0.166 keeps a trust hash per hook entry (`[hooks.state]` in
`~/.codex/config.toml`). After `remotea hooks install` changes an entry (this
change raises PermissionRequest's timeout from 10 to 600 s), the next Codex
start shows "Hooks need review"; trust them once in a terminal (`/hooks`, or
"Trust all and continue"). Until the new entry is installed the adapter is
not advertised (`adapterHooks` reads the timeout), and an Eridani-spawned
Codex that hits the review screen waits there like any other prompt.

### Harness capability matrix

hello's `harnesses.<h>`, as this build sends it on a host with Claude Code
2.1.314, Codex CLI 0.166.0 and OpenCode 1.17.20 installed and hooks
installed. "start" is `spawn` (also gated on a target that enables the
harness and a working launcher); "loop" is `loop` (turns captured, and
`input` queue/steer continues the run).

| | observe | capture | question / answer | context | start (`spawn`) | resume | loop | permission |
|---|---|---|---|---|---|---|---|---|
| claude | yes | yes (Stop `last_assistant_message`) | yes: `ask` (AskUserQuestion) | yes | per target | yes (`claude --resume`) | yes | `capture` |
| codex | yes | yes (Stop `last_assistant_message`, `turn_id`; rollout fallback) | yes: `approval` (PermissionRequest, allow once / deny); `request_user_input` stays in the terminal | yes | per target | yes (`codex resume`) | yes | `answer` |
| opencode | yes (wmux plugin) | no | no | no | no | no | no | `capture` |

`question` is computed, never assumed (harness-adapters.ts): a kind is
advertised only when the installed version is in the range its capability
test ran on (lowest tested version up to the next minor) and its hook is
installed with the long timeout. A Claude or Codex update past the range
turns the flag off, and remotea stops holding those prompts, until the test
is re-run and the range widened. Unsupported controls stay off, so Eridani
keeps showing "open the terminal" for them.

| Adapter | Tested on | Advertised for | How |
|---|---|---|---|
| claude `ask` | 2.1.312 (stage A spike, spike-stage-a/capability-matrix.md) | 2.1.312 ≤ v < 2.2.0 | Real Claude Code; single, multi, free text, several questions per call. 2.1.314 (installed now) is advertised under the range rule; it was not re-run in this change. |
| codex `approval` | 0.166.0 (2026-10-30) | 0.166.0 ≤ v < 0.167.0 | `node remote-server/scripts/capability-codex.mjs`: the installed Codex TUI in a PTY, a scratch `CODEX_HOME` with test hooks, a local fake Responses API that asks for an escalated `touch`. |

Codex 0.166.0 record (`codex --version` → `codex-cli 0.166.0`;
`capability-codex.mjs` output, all PASS):

- approval-allow: decision `allow` → the command ran, no prompt shown;
- payload: PermissionRequest keys `cwd, hook_event_name, model,
  permission_mode, session_id, tool_input, tool_name, transcript_path,
  turn_id` (no `tool_use_id`; `tool_name: "Bash"`, `tool_input {command,
  description}`);
- held-screen: "Running hook" while the hook holds;
- stop-capture: Stop carries `last_assistant_message` and the same `turn_id`
  as UserPromptSubmit (turn-capture.ts keys Codex turns by it: correct);
- approval-deny: "Blocked by hook", the command did not run;
- approval-none / approval-timeout: Codex's own prompt;
- question-pre: PreToolUse fires for `request_user_input` with
  `tool_input.questions`, but an `updatedInput` with answers is ignored and
  the TUI still asks. Not answerable by a hook.

Codex questions (`request_user_input`), and why they stay in the terminal:
the tool exists only in Plan mode, or in Default mode behind the
`default_mode_request_user_input` feature ("under development", off). The
App Server protocol (`codex app-server generate-ts`, 0.166.0) has a typed
answer, `item/tool/requestUserInput` → `{answers: {<id>: {answers:
[…]}}}`, and typed approvals (`item/commandExecution/requestApproval` with
`acceptForSession`), but server requests go to the client that owns the
thread, which is the TUI remotea spawns. Driving it would mean spawning
Codex as `--remote` against an app server remotea runs, a launch change not
made here. Keystrokes into the TUI's question view ("Question 1/1", numbered
options, "enter to submit answer") were not implemented: no structured
proof that a keystroke landed.

Claude permission prompts stay captured: no keystroke shape was verified for
this change. (Claude's own PermissionRequest hook takes the same
`decision.behavior` output as Codex's; it is the structured path if this is
taken up, after a capability test like Codex's.)

OpenCode 1.17.20 (`opencode --version`): the wmux plugin is installed and
reports status (observe). Its `question.asked` / `permission.asked` events
reach the plugin, and `opencode --help` lists `--prompt`, `--session`,
`--continue` and `--model`, but nothing here was run: Eridani cannot spawn
OpenCode (no launch path, `SPAWN_HARNESSES` is claude and codex), so no
OpenCode session is ever bound to a run and nothing could be held. hello
probes `opencode --version` like the others so `installed`/`version` are
facts; every control is off.

### Context (SessionStart)

The SessionStart hook asks the server (`remotea.context`), which sends
`context.request {req_id, surf, incarnation, provider, provider_session_id,
source, cwd, run_id, generation, task_id}` and waits 2.5 s for
`context.response {req_id, text, run_token?}`. The text (≤ 16 000 chars) is
printed for the agent, followed by `Eridani run token: <token>` when there is
one, then, for a run's surface, whether the Eridani MCP tools are available
(see [Eridani MCP](#eridani-mcp-for-spawned-agents)). With no answer in time, one line naming the tool, session and run is
printed instead; a late response is dropped. Nothing is printed when the link
is not enabled.

Since stage F (D6), `context.response` carries `scope: "run" | "candidates"`.
The full text (`run`) is printed only for a surface bound to a run. An unbound
session, meaning one of Davin's own in a folder an Eridani rule covers, gets
only the short fenced candidate-task list (`candidates`), at most 4 000
characters. remotea drops `run` text and any run token sent for an unbound
surface. The handling of an unscoped answer depends on Eridani's welcome:

- If the welcome advertised `context.scope`, an unscoped answer to an unbound
  surface is dropped too.
- If it did not (an older Eridani), the answer is printed as before. This keeps
  the two sides able to lag one release apart.

### Other frames

remotea also sends: `question`, `question.resolved`, `verify.result
{attempt_id, run_id, generation, turn_seq, plan_revision, verify_id,
workspace_fingerprint ("<HEAD>:<sha256 of the branch, status, diff and
untracked contents>"), exit_code, tail (last 4000 chars), truncated, duration_ms,
timed_out, canceled, error?, isolated?, isolation?, isolation_reason?,
workspace_complete?, workspace_reasons?}` (the last five: see
[stage D](#stage-d-verification-after-turns)) and `worktrees.report {worktrees: [...], heads?: [...]}` (on
ready, after a spawn or exit, and every 2 min when it changed; on `worktrees.scan`
always). `turn` now
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

**Fingerprint completeness (S-S2).** The fingerprint is exact only when it
covered everything. `workspace_complete: false` says it did not, and
`workspace_reasons` says what it missed, one line per gap:

| Gap | Reason line |
|---|---|
| `git status` exited non-zero | `git status failed` |
| `git diff HEAD` exited non-zero (including output over 16 MiB, which cuts it) | `git diff failed` |
| more than 2,000 untracked files (only the first 2,000 are hashed) | `untracked files capped at 2000 (<n> found)` |
| untracked files over 4 MiB (hashed by size and mtime, not content) | `<n> untracked file(s) over 4 MiB hashed by size and mtime` |
| untracked entries that are not regular files, e.g. a nested repository | `<n> untracked entr(y/ies) not a regular file (e.g. a nested repository) hashed by size and mtime` |
| untracked files that vanished or could not be read | `<n> untracked file(s) could not be read` |
| the workspace was not read at all (missing worktree, refused cwd) | `the workspace was not read` / `the workspace could not be read` |

Both fields describe the fingerprint taken BEFORE the run (the one in
`workspace_fingerprint`); `workspace_reasons` is `[]` when complete. Eridani
should treat `workspace_complete: false` as **not fresh** for auto-completion:
the hash cannot prove the tree it tested is the tree the turn left. remotea
itself does not resend a finished host attempt under an Eridani `verify`
command when its fingerprint was incomplete; it runs again. Untracked
symlinks are hashed by their target name (exact). A repository with no commit
yet hashes `git diff --cached` and `git diff` instead of `git diff HEAD`.

`verify.result` now: `{attempt_id, run_id, generation, turn_seq,
plan_revision, verify_id, workspace_fingerprint, workspace {head, branch,
tree}, turn_fingerprint?, stale_workspace, initiator: host|eridani,
adopted?, exit_code|null, tail, truncated, duration_ms, timed_out, canceled,
error?, isolated?, isolation?, isolation_reason?, workspace_complete?,
workspace_reasons?}`. Output is the last 4000 characters of stdout and stderr
together. The S-N4 / S-S2 fields are additive and optional (an older host
omits them):

| Field | Type | Meaning |
|---|---|---|
| `isolated` | boolean | The command ran inside the bubblewrap sandbox. False also when it never ran (a refusal, a missing worktree). "Tests passed" (`exit_code: 0`) and "the check was isolated" are separate facts. |
| `isolation` | `"bwrap"` \| `"none"` | The isolation the entry gets: its `isolation`, or the default (`bwrap` where bwrap works, else `none`). `bwrap` with `isolated: false` and an `error` means the entry demanded the sandbox and the host could not provide it, so nothing ran. |
| `isolation_reason` | string, ≤ 300 | Why not isolated, e.g. `the entry sets isolation "none"`, `bwrap (bubblewrap) is not installed on the service PATH`, `bwrap does not work on this host (…)`. Absent when isolated. |
| `workspace_complete` | boolean | The fingerprint covers the whole workspace (above). |
| `workspace_reasons` | string[] | What it missed; `[]` when complete. |

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

### Verify isolation

Code: `remote-server/src/verify-sandbox.ts` (S-N4). Verify runs the
worktree's code, which the agent edits (`package.json` scripts,
`conftest.py`). Where [bubblewrap](https://github.com/containers/bubblewrap)
works, that code runs in a sandbox:

| | Inside the sandbox |
|---|---|
| Namespaces | its own user, pid, ipc, uts and network (`--unshare-all`); killed with the server (`--die-with-parent`); its own session (`--new-session`) |
| Read-only | `/usr`, `/bin`, `/sbin`, `/lib*`, `/etc`; the run's `PATH` folders; the install prefix of the node that runs remotea; the worktree's `node_modules`, `.venv`, `venv` (at the worktree root and at the entry's `cwd`) when they are symlinks to somewhere else, and a venv's base Python (`home` in `pyvenv.cfg`); a linked worktree's git folders (`.git` points into the repository's); the entry's `mounts` |
| Read-write | the worktree; a private `/tmp` (tmpfs, gone after the run) with `HOME=/tmp/home` in it, empty; a tmpfs over `.vite-temp`, `.vite`, `.cache` inside a read-only `node_modules`, where they exist (vite writes there) |
| Absent | everything else: the real `$HOME` and its keys, dotfiles, `~/.config`, other checkouts, `/run`, `/var` |
| Root | remounted read-only after the mounts, so nothing else can be created |
| Network | none (only a private loopback the command can serve itself on), unless the entry says otherwise (below) |
| Limits | no core dumps (`ulimit -c 0`); the entry's timeout kills the whole tree (as before) |
| Environment | the minimal one (`PATH`, `LANG`, `CI=1`, `TERM=dumb`, the entry's `env`), with `HOME=/tmp/home` unless the entry's `env` sets `HOME` |

**The trust choice** is per verify entry in `eridani.json`:

```json
"verify": [{
  "id": "tests", "argv": ["uv", "run", "--no-sync", "python", "-m", "pytest", "tests", "-q"], "timeout": 600,
  "isolation": "bwrap",
  "network": "loopback", "ports": [5432],
  "mounts": ["~/.local/share/uv/python"]
}]
```

| Field | Values | Meaning |
|---|---|---|
| `isolation` | `"bwrap"` \| `"none"`; absent | Absent: `bwrap` where it works, else `none`, and hello (`verify_status[].isolated: false, isolation_reason`) and every `verify.result` (`isolated: false`) say so. `"bwrap"`: required; where bwrap is missing or broken the run is **refused** (`exit_code: null`, `error: isolation "bwrap" is required but …`, `ready: false` in hello), never run unsandboxed. `"none"`: run as the server user, the old way, by choice (`isolation_reason: the entry sets isolation "none"`). |
| `network` | absent / `false`; `"loopback"`; `true` | `false`: no network. `"loopback"`: only the HOST's `127.0.0.1` on the listed `ports` (below). `true`: the host's whole network namespace, the internet included. |
| `ports` | 1 to 16 port numbers | Only with `network: "loopback"`. |
| `mounts` | up to 32 absolute or `~/` paths (not `/`) | More read-only folders, e.g. a uv-managed Python (`~/.local/share/uv/python`) or a tool outside `/usr`. A missing path is skipped. |

**A test database on localhost** (`network: "loopback"`). The sandbox has its
own network namespace, so the host's `127.0.0.1:5432` is not reachable
directly. For each listed port remotea opens a unix socket in a private
folder (`$TMPDIR/remotea-loopback-*`, mode 0700, removed after the run) that
forwards to the host's `127.0.0.1:<port>`, mounts that folder read-only at
`/run/remotea-loopback`, and starts the command behind a small forwarder
(run by remotea's own node) that listens on the sandbox's `127.0.0.1:<port>`
(and `::1`) and relays each connection through the socket. The test connects
to `localhost:5432` as usual; every other port, and every other address, is
unreachable. A database reached through its unix socket instead (e.g.
`/var/run/postgresql`) can be added to `mounts` with `network` left off;
connecting to a socket works through a read-only mount.

**Where the check is not isolated.** A host without `bwrap`, or where the
probe sandbox fails (unprivileged user namespaces disabled), runs default
entries unsandboxed with `isolated: false` and the reason. WSL2 with
`apt install bubblewrap` works (bubblewrap 0.9). `remotea eridani status`
prints `sandboxed` / `NOT sandboxed (reason)` per verify entry.

**Practical notes.**

- A `node_modules` symlinked from the main checkout is read-only: an install
  step inside verify fails. Install into the worktree (a real folder there is
  read-write) or keep the install outside verify.
- Tools that need files under the real `$HOME` (a uv-managed Python, a
  `~/.cargo` toolchain, git's `user.name`) need `mounts` or `env`: the
  sandbox's `HOME` is empty. Never mount a folder with credentials.
- The repository's git folder is mounted read-only (tests that read git
  state work; ones that commit to the worktree's own repository fail). A
  token written into a remote URL in `.git/config` is readable inside.
- No memory or process-count limit (that needs cgroups); the timeout and the
  tree kill are what bound a run.

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

## Stage F: security model

Stage F fixed the remotea items of the 2026-10-28 security audit. This
section states what the trust boundary is now, including what it still does
not cover.

**Who can drive a terminal.**

- remotea is a same-user system. The hub token (`~/.config/remotea/token`) is
  shell access: any process running as Davin can read it and type into every
  remotea terminal, including Davin's own sessions with a cached `sudo` or an
  SSH login.
- That includes an agent. A Claude in auto mode, or any unsandboxed agent,
  can drive every remotea terminal, not only its own. Sandboxed Codex can read
  the file but cannot connect, because it has no network.
- Windows processes reach 7717 and 7718 through mirrored loopback, but still
  need the token.

**Where the hub listens.**

- The hub binds `127.0.0.1` **and `tailscale0`** by default (`config.bind`),
  so every tailnet device can reach 7717.
- That is acceptable: the 256-bit token and the 10-failures-per-minute ban
  hold. Restricting 7717 to your own devices with Tailscale ACLs adds depth,
  and is recommended.
- The hook bridge (7718) is loopback only.

**What Eridani's text can become.**

- `input` text is a bracketed paste and nothing else.
  - `commandShapeError` refuses C0/C1 controls other than newline and tab
    (ESC, CSI U+009B, CR, Ctrl-C), so a nested `\x1b[201~` cannot end the
    paste early. `\x1b[Z` (Shift+Tab, which cycles the permission mode) cannot
    arrive as a key either.
  - Text that starts with `/` (a slash command) or `!` (Claude Code's shell
    mode) is refused.
  - `type()` also strips every such control before typing, as defence in
    depth.
- `input`, `steer` and `answer` are accepted only when two things hold for the
  surface's **current incarnation**:
  - remotea launched it with the run's own agent command (the spawn line or
    the resume line);
  - that agent has reported its session through its hook.

  A shell, or an agent that never started, gets a typed `rejected` outcome
  (`the agent has not reported its session yet`, …). A lost run that cannot
  be resumed stays exited (above).

**Verify.**

- Verify runs the worktree's code: `package.json` scripts, test files,
  `conftest.py`. The agent edits that code freely. It runs 2 s after every
  root turn, outside the agent's own sandbox. Since S-N4 it runs in a
  bubblewrap sandbox where bwrap works ([Verify isolation](#verify-isolation)):
  a temporary HOME, the worktree the only writable folder besides a private
  /tmp, no network unless the entry allows it. An entry with
  `isolation: "none"`, or any entry on a host without bwrap, still runs with
  network and Davin's privileges, so a sandboxed Codex agent's edits run
  unsandboxed and a Claude agent's commands skip the auto-mode classifier;
  `verify.result` then says `isolated: false`.
- Stage F does the cheap parts:
  - The child gets a minimal environment: `PATH`, `HOME`, `LANG`, `CI=1`,
    `TERM=dumb`, plus only what the verify entry's own `env` names
    (`"env": {"NODE_OPTIONS": "…"}`). Keys follow shell variable rules, with
    at most 32 one-line values. The server's environment (keys, tokens,
    `SSH_AUTH_SOCK`) never reaches it.
  - The cwd is resolved with `realpath` before the containment check, so a
    symlinked folder cannot point outside the worktree.
  - A spawn's `target.base` must be a local branch, a tag or a commit id of
    the target's repository. A remote-tracking ref is accepted only for the
    target's own configured base. An arbitrary ref such as
    `origin/<someone's PR>` is refused.
- S-N4 runs verify inside bubblewrap, with no network by default (see
  [Verify isolation](#verify-isolation)). Automatic verify stays on.

**What leaves the machine.**

- Verify tails and errors, question items, the answer echo and the
  `needs_you` reason go through the shared redaction list
  ([redaction.md](redaction.md)). Turns and session reports already did.
- Eridani redacts every host free-text field again on ingestion.

**Claims, not facts.**

- A session's own hook token can report its hook events, so the following are
  claims made by the agent, not facts the host verified:
  `effective_permission_mode` on `status`, turn text, Stop, and idle. An agent
  can claim `default` while it runs in `bypassPermissions`, or fake a Stop
  for its own surface (only its own).
- Eridani should treat these fields as agent claims.

**SessionStart text.** Full Eridani context reaches only run-bound surfaces.
Other sessions see at most the fenced candidate list (D6, above).

**Link URL.**

- `ws://` is accepted only for `localhost`, `127.0.0.1` and `::1`.
- The CLI refuses anything else. The server checks again when it reads
  `eridani.json`, because the file can be edited by hand. The key is sent in
  every handshake.

**Hook files.** `remotea hooks install/remove` keeps the mode of
`settings.json` / `hooks.json`, whatever the umask. The
`.remotea-backup` copy is always 0600.

**Capabilities.** hello adds `digest` (every op frame carries its digest, so
Eridani may require it), `context.scope`, `prompt` (live `prompt` frames,
sent only when Eridani advertises `prompt` back), `worktrees.scan` (the
host takes the [`worktrees.scan`](#commands) command; an Eridani that never
sends it loses nothing), `terminal.focus` (the host takes the
[`terminal.focus`](#commands) command; likewise optional), `run.reopen` (the
host takes the [`run.reopen`](#commands) command; Eridani sends it only to a
host that advertises it), `doctor` (live
[`doctor`](#doctor) frames, sent only when Eridani advertises `doctor` back;
hello carries the summary regardless) and `spawn.roles` ([Roles and read-only
modes](#roles-and-read-only-modes-hyperplan); an Eridani that never sends
`role` or `mode` gets the same host as before). The lag rules:

- Eridani refuses an `op_id` frame without a digest only from a host that
  advertises `digest`.
- remotea scopes context strictly only when Eridani advertises
  `context.scope`.

## Doctor

`remotea doctor [--json] [--probe]` (S-Q1) is one readiness report for the
host: whether the apps and Eridani can rely on it, and what to do when they
cannot. It only reads: it never starts, restarts or installs anything, does not
create `config.json`, and never runs `git fetch` (the worktree check uses the
local refs). `--probe` also runs each harness's launch probe, as
`remotea eridani status --probe` does; without it, launch readiness comes from
the running server's last probes in `eridani-status.json`.

Every check is one line with a level (`ok`, `warn`, `fail`) and, for warn and
fail, a one-line fix. The exit code is 1 when any check fails, else 0.

Redaction, applied to every line before it is printed or sent:

- no keys or tokens (the token check reports presence and file mode only; the
  link and MCP keys only whether they are configured), and anything shaped like
  a key is replaced (`redact` in `eridani-setup.ts`);
- no environment dumps: the service `PATH` is shown, nothing else from the
  unit or the process environment;
- paths under `$HOME` are written with `~`.

Checks, by section (ids are stable; `<t>` is a target id, `<h>` a harness,
`<v>` a verify id):

| Section | Ids | What |
|---|---|---|
| service | `service.unit`, `service.active`, `service.user`, `service.path` | The user unit is installed and enabled, is running (`systemctl --user is-active / is-enabled` only), its user, and the `PATH` from the unit file. |
| build | `build.running`, `build.disk`, `build.main`, `build.caps` | The running server's build (sha, dirty, version, uptime from `server-info.json`) against the one on disk, proto and caps version. `build.main` compares the running build's commit (the one on disk when no server runs) with `refs/heads/main` on `origin`: warn when origin has commits the build lacks, with the count when origin's commit is already in the local object store and "unknown until that commit is fetched" otherwise; ok when level or ahead, and ok "not compared" when the build has no commit, does not run from a built checkout, or origin cannot be asked. It only reads the remote ref (`git ls-remote origin refs/heads/main`, 2.5 s limit, then local `rev-list` / `cat-file`): it never fetches and never changes the checkout. `remotea status` prints the same sentence after its build line (`server.mainRef` in `--json`). |
| listener | `listener.port`, `listener.token`, `listener.hooks` | Port 7717 accepts and `/healthz` answers; the token file exists and is 0600; the hook bridge accepts. |
| collector | `collector.mode`, `collector.sqlite`, `collector.scan` | Mode (parity, authoritative, off), `node:sqlite` available for Codex sessions, the last scan's age and result. |
| eridani | `eridani.link`, `eridani.backlog`, `eridani.journal`, `eridani.rejected` | Configured, link state, last welcome, `degraded_reason`, outbox backlog, journal health, frames refused for good. |
| hooks | `hooks.helper`, `hooks.claude`, `hooks.codex`, `hooks.codex.trust`, `hooks.opencode` | The helper is current (`hook_version`); per agent, our hook entries installed vs expected; Codex hook trust from `~/.codex/config.toml` (`hooks.state` trusted hash, not disabled); the OpenCode plugin matches the bundled one. |
| targets | `targets`, `targets.isolation`, `target.<t>.config`, `target.<t>.repo`, `target.<t>.template`, `target.<t>.worktree_root`, `target.<t>.base`, `target.<t>.prepare.<p>`, `target.<t>.migrations`, `target.<t>.limits.disk`, `target.<t>.launch.<h>`, `target.<t>.verify.<v>`, `target.<t>.verify.<v>.deps`, `target.<t>.verify.<v>.db`, `target.<t>.mcp` | Per target: the repository; each enabled harness's launcher; each verify entry (ready and reason, isolation when the server reports it, else whether `bwrap` is on the service `PATH`; the program resolvable under the service `PATH`; `node_modules` present for a Node runner (npm, npx, pnpm, yarn, bun, node, vitest, jest, tsc) in a `package.json` project, `.venv` for a bare Python runner (pytest, python, alembic) in a Python project, unless the entry installs first; a database URL key (`*DATABASE_URL`, `*DB_URL`, `*_DSN`, `PGHOST`…) in the entry's `env` when the command runs pytest, alembic, manage.py, prisma and the like in a repository with `alembic.ini`: the key name only, never the value; a wrapper script is not judged; a Node runner counts as installed when the target has `prepare` steps); the MCP key for spawned agents. S-Q3: an entry of `targets` ignored as invalid (`config`, fail); the template as a whole (`template`: ok, or fail "not advertised as ready" with the reasons) and each of its problems not covered by another item ([Target templates](#target-templates-s-q3)). |
| disk | `disk.config`, `disk.temp`, `disk.worktrees.<t>` | Free space where the config, temp files and each target's worktrees live: warn under 5 GiB or 5% free, fail under 1 GiB or 1%. |
| uploads | `uploads.budget` | Pasted and dropped files in `/tmp/remotea-drop-*` against the upload budget (the server's `uploads-status.json` when it writes one, else a count). |
| recovery | `recovery.worktrees`, `recovery.sessions` | Managed worktrees with unmerged commits or uncommitted changes (the cleanup report, without fetching); sessions still marked live from an earlier server boot (stale PTY leases). |

`--json` prints (stable; `version` changes only on an incompatible change):

```ts
{
  version: 1,
  at: number,            // epoch ms
  hostname: string,
  probed: boolean,       // --probe was given
  ok: number, warn: number, fail: number,
  items: Array<{
    id: string,          // as in the table above
    section: 'service' | 'build' | 'listener' | 'collector' | 'eridani' | 'hooks' | 'targets' | 'disk' | 'uploads' | 'recovery',
    level: 'ok' | 'warn' | 'fail',
    summary: string,     // one line, redacted
    fix?: string,        // one line, on warn and fail
  }>,
}
```

New ids and sections may appear; consumers ignore ones they do not know.

**To Eridani.** The running server computes the same report (without
`--probe`; it uses its own launcher probes) every 5 minutes and after each
reconfigure, and sends the warn and fail lines as a summary:

```ts
doctor: {
  at: number, ok: number, warn: number, fail: number,   // the counts cover every check
  items: Array<{ id: string, level: 'warn' | 'fail', summary: string, fix?: string }>,
  truncated?: true,     // items were dropped to fit the cap
}
```

- At most 40 items (`ERIDANI_LIMITS.doctorItems`), fails first; `summary` and
  `fix` at most 200 characters (`doctorTextChars`), `id` at most 120
  (`doctorIdChars`). ok lines are never sent.
- hello always carries the latest summary as `doctor` (absent until the first
  one is computed). Eridani's `Hello` model ignores unknown fields, so an older
  Eridani loses nothing.
- After welcome, a changed summary goes as a `doctor` frame (bulk lane, op
  frame with `op_id` and `digest`, coalesced on `doctor` so only the latest
  waits, ephemeral: never written to the outbox file). It goes only when the
  welcome's `caps` include `doctor`, the same gate as `prompt`; an older
  Eridani would refuse a frame type it does not know. "Changed" compares the
  counts and items, not `at`, so an unchanged host sends nothing.
- remotea advertises `doctor` in its hello caps (with the stage F caps).
- Eridani's side (jarvis): add `doctor` to its welcome caps, accept the
  `doctor` frame and the hello field, and keep the latest summary per host.

## Not yet implemented (stage F and later)

- **Verify sandbox gaps** (S-N4 did the rest): no memory or process-count
  limit (cgroups); a `node_modules` shared from another checkout is
  read-only rather than a throwaway overlay (bubblewrap 0.10's
  `--tmp-overlay`); where bwrap is missing, default entries still run
  unsandboxed (`isolated: false`). Eridani's side: show `isolated` next to the
  result, and treat `workspace_complete: false` as not fresh (jarvis
  follow-up).
- Answering Claude permission prompts (captured only), Codex
  `request_user_input` questions (no hook can answer them; see
  [Harness capability matrix](#harness-capability-matrix)), and anything
  from OpenCode (not spawnable).
- Eridani's side of Codex approvals: its answer gate checks
  `harnesses.claude.question` for every question; it should check
  `harnesses[<question provider>].question_kinds` (jarvis follow-up).
- Removing worktrees (nominate only, by design).
- Eridani's side of target templates (S-Q3): Eridani already starts nothing
  on a target advertised with `harnesses: []`, but its message then reads as
  if the target did not enable the harness. It should show
  `targets[].template.problems` on the target picker and in that refusal,
  and recognise the `target_not_ready` and `target_busy` spawn rejections
  (jarvis follow-up). Templates hold no CPU or memory limits yet (cgroups).
- Eridani's side of `mcp.configured: false` (task 3bc2803c): remotea only
  reports it. Eridani should show the reason on the run and on the target
  picker, and should not wait for a `submit_plan` that cannot come. It could
  refuse to spawn on such a target, or fall back to reading the plan from the
  turn text.
- Deleting the Python collector's code, units and credential: Davin's step,
  one release after a clean cutover (below), not code here.
