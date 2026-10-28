# The Eridani link (stage B)

remotea-server can keep one outbound WebSocket to Eridani. In stage B the link
is **read-only**: it reports what agents in remotea terminals are doing (state,
finished turns, exits) and runs the session collector in **parity mode**. It
executes nothing Eridani sends.

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

## Configuration

Both files live in the server's config dir (`~/.config/remotea`, or
`$REMOTEA_CONFIG_DIR`).

`eridani.json`:

```json
{ "enabled": true, "url": "wss://eridani.example/api/v1/external/agents/link", "machine": "DavisPC", "collector": "parity" }
```

- `machine` (optional) is the name reports carry; it defaults to the hostname.
- `collector` is `"parity"` (default) or `"off"`.

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

`remotea status --json` gains, additively (`version` stays 1):
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
  `ack ok:false error:"digest-mismatch"`.

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
4. Only after the parity report has been clean for long enough does stage C
   switch the collector to authoritative and retire the Python one. That is not
   done here.

The collector scans when the link becomes ready and every 2 minutes. It also
rescans one conversation right after each of its turns. Scans are skipped
while the outbox is over 80% full.

A source's fingerprint is recorded (`eridani-collector.json`) only when
Eridani acks the report that carried it.

## Not yet implemented (stage C and later)

- Executing anything inbound: prompt injection, answering questions, the
  PreToolUse hold, and context on SessionStart. The journal is built and
  records outcomes, but stage B rejects every command as `unsupported`.
- `context.request` / `context.response`: the types exist, but nothing is sent.
- Run bindings: `run_id` is always `null` and `generation` 0.
- Switching the collector from parity to authoritative, and removing the
  Python collector's hooks.
- `effective_permission_mode` on `status`.
