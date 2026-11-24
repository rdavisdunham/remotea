# Upgrading the server without ending sessions (S-Q5)

Eridani task `7a9761ad`, Astra review S-Q5. Off by default: `"ptyKeeper": true`
in `~/.config/remotea/config.json` turns it on.

## The problem

The session server (`remote-server/`, `remotea.service`) owns every PTY as a
child process, and the unit runs with `KillMode=control-group`. Restarting it,
for an upgrade or anything else, hangs up every terminal. The apps respawn the
tabs and Claude and Codex conversations are resumed, but whatever an agent was
doing at that moment is cut off, and an Eridani run starts a new incarnation.

## The shape

Split what must live long from what must be restartable.

```
remotea.service (restartable)                  PTY keeper (long-lived)
┌──────────────────────────────────────┐ unix   ┌─────────────────────────────┐
│ hub, registry, headless xterm/session│ socket │ node-pty per session         │
│ app protocol, hook bridge            │◄──────►│ output ring + sequence nos.  │
│ Eridani link, journal, spool,        │ NDJSON │ the last emulator checkpoint │
│ dispatch, collector, verify          │        │ nothing else                 │
└──────────────────────────────────────┘        └─────────────────────────────┘
```

**The keeper** (`remote-server/src/pty-keeper/`) is a small Node process, one
per config directory. It runs with the same `node` and the same `node-pty`
module as the server and uses no other dependency. It spawns the processes the
server asks for, with exactly the file, arguments, directory and environment
the server computed (`spawnSpec`, so a session is the same whichever side
starts it). It keeps a bounded ring of each session's output, numbered, and an
opaque checkpoint the server hands it. It does not parse terminal output, know
about registries, apps or Eridani, and it never decides anything. A small
keeper rarely needs upgrading, which matters because restarting the keeper is
exactly what ends sessions.

- **Where it runs.** When the server runs under systemd (`INVOCATION_ID` is
  set), the keeper is started as its own transient user unit,
  `systemd-run --user --unit remotea-pty --collect`, so it is not in
  `remotea.service`'s cgroup and `KillMode=control-group` does not reach it.
  Otherwise (a dev run, the tests) it is a detached process (`setsid`) that
  logs to `<config>/pty-keeper.log`. A second keeper for the same directory
  sees the live socket and exits. `<config>/pty-keeper.pid` holds its pid.
- **Socket.** `<config>/pty-keeper.sock` (0600 in a 0700 directory), or
  `/tmp/remotea-pty-<hash>.sock` when that path is too long for a unix
  socket. Only the same user can connect.
- **Protocol** (`pty-keeper/protocol.ts`, `KEEPER_PROTO = 1`): one JSON object
  per line. `hello {proto, role: owner|observer}` → `welcome {proto, pid,
  version, startedAt, owner, sessions[]}`. An owner may `spawn`, `attach`,
  `write`, `resize`, `pause`, `resume`, `kill`, `close` (hang up, then
  SIGKILL after 2 s), `forget` and `checkpoint`; the keeper sends `data {id,
  seq, data}` and `exit {id, exitCode, signal}` for attached sessions. An
  observer (`remotea status`, `doctor`, `upgrade`) only gets the welcome.
  There is one owner at a time: a newer owner replaces the older one
  (`replaced`, then the socket closes). The keeper outlives server upgrades,
  so this protocol only grows: a newer server must speak every older keeper
  version it may find, and a keeper ignores fields and messages it does not
  know (answering `error` to an unknown request).
- **Attach** answers `{seq, alive, exitCode, cols, rows, checkpoint?,
  chunks}` and from then on streams the session. With a checkpoint whose
  sequence number the ring still covers, `checkpoint.data` plus the chunks
  after it rebuild the screen exactly; otherwise the whole ring is replayed
  (`truncated` says the ring had already dropped the start), which draws the
  recent screen and is repaired by the agent's next repaint.
- **Flow control.** While an owner is attached, `pause` and `resume` reach the
  PTY; a socket backlog over 4 MiB pauses every PTY until it drains. With no
  owner every PTY runs and only the ring keeps output.
- **Lifetime.** The keeper exits on its own after `ptyKeeperIdleMinutes`
  (default 10) with no owner and no live session. SIGTERM (stopping the unit)
  hangs up every session first. Stopping the keeper is how to end every
  session for good: `systemctl --user stop remotea-pty`.

**The server** chooses a backend per session. With `ptyKeeper: true` new
sessions are spawned in the keeper (in process when the keeper cannot be
reached, with a log line). With it off, sessions are spawned in process as
before, but a keeper that is still running is attached anyway, so turning the
option off never leaves a session that two processes think they own.

On start, before it listens, the server attaches to the keeper as owner and
**adopts** every session it holds:

- A session the registry has (the boot marked it `lost`) and the keeper has
  alive becomes `live` again with this boot's id. Its incarnation, turn
  numbering, agent, Eridani binding and agent state are untouched. Its
  headless terminal is rebuilt from the checkpoint and ring.
- One that exited while no server was attached is recorded as exited with its
  real code (the usual exit path: the apps, dispatch and Eridani see it).
- One the registry does not have (closed meanwhile) or has as exited is hung
  up and forgotten.

So the apps reconnect (the boot id changed, so each pane gets a snapshot) and
find the same live sessions: no restore notice and no respawn. Eridani gets the
new `boot_id` in hello and a `sessions.snapshot` that says `live` with the same
`incarnation` for every adopted surface. The journal and outbox are on disk
and are replayed as after any restart.

Dispatch keeps the M7 fence across the restart: which incarnation it launched
with the run's command, and whether that agent reported its session, is now
mirrored to `<config>/eridani-launched.json` (0600) and read back only for a
session that was adopted alive in the same incarnation. A stop that was executing when the
server went down is reported `failed` ("interrupted by a server restart") when
the process outlived it; the stop stays requested and boot sends it again.

On SIGTERM a server with keeper sessions does not hang them up. It stops
taking their output, checkpoints each emulator (serialized screen and
scrollback at a known sequence number), hands the checkpoint to the keeper and
closes the socket. Sessions spawned in process still end as before.

## Draining: `remotea upgrade`

Surviving a restart is not the same as a clean handover: a steer half-typed
(Esc sent, text not yet) is cut off by any restart. `remotea upgrade` drains
first:

1. Checks the server runs and supports drain (`server-info.json` `features`).
   Without the keeper it says the restart ends sessions and stops unless
   `--yes`.
2. Writes `drain-request.json` and sends the server SIGUSR2. The server:
   - tells Eridani: the next `hello` carries `draining: true`, and when the
     welcome advertised `draining`, a `host.state {draining: true, reason}`
     frame goes out at once (additive: an Eridani without the capability is
     sent nothing new);
   - keeps accepting commands but holds them: they are journaled `accepted`
     and acked, and not run; the new server replays them after its
     `runs.snapshot`, as it would after any restart;
   - starts no queued input;
   - waits until no command has begun without settling and no steer or input
     write is pending, then writes `drain-status.json` `settled` (or `timeout`
     after `--timeout`, default 30 s, listing what was still in flight).
   A drain that is not followed by a restart expires (timeout + 60 s): the
   server stops draining, tells Eridani, and runs what it held.
3. Restarts the server unit only (`systemctl --user restart remotea`, or
   `--unit`); the keeper unit is not touched.
4. Waits for a new boot to answer `/healthz`, then compares: every session the
   keeper held alive before should be `live` in the new boot with the same
   incarnation. It prints what survived, what did not, and exits 1 if any did
   not.

`install.sh` uses `remotea upgrade --yes` instead of a bare restart when the
keeper is on.

`remotea status` shows the keeper (`server.ptyKeeper` in `--json`: enabled,
running, pid, version, proto, owner attached, sessions held and alive) and
`remotea doctor` reports it under `service.pty_keeper`.

## What is left out

- **Upgrading the keeper itself** without ending sessions (fd passing to a
  new keeper). Restarting the keeper ends its sessions, like restarting the
  server did before; the apps and dispatch then respawn and resume as usual.
- **Held Claude questions and Codex approvals** across a restart: the hook
  helper's held request ends with the server and the prompt falls back to the
  terminal, as today.
- **Verify runs** in progress still end with the server (`failed`,
  "interrupted by a server restart").
- **A keeper that dies** (crash, OOM, `systemctl stop remotea-pty`) takes its
  sessions with it; the server records them as exited (-1).
- **A keeper this server cannot drive** (one that answers with another
  protocol version, which v1 is designed never to need): the server logs it
  and runs new sessions in process, and the sessions that keeper holds are
  treated as lost, so their apps and runs may respawn them beside the old
  processes. `remotea doctor` warns when a keeper holds sessions no server is
  attached to.
- **Startup commands** typed into a brand-new shell (`remotea open -- cmd`)
  are not resumed if the server is restarted before the shell was ready.
- **Eridani's side** of `draining`: storing it on the host and holding new
  dispatch while it is set. Until Eridani advertises `draining`, it simply
  sees a short disconnect and a reconnect with the same surfaces live.


### Activating Google Glass access to ordinary manual host sessions

This host integration is opt-in. Build a separate release against the same Remotea revision as the live host. Keep the running executable, service configuration and rollback artifacts in place until the replacement is tested. Build native dependencies on the target architecture.

Set `REMOTEA_GLASSFACE_DEVICE_ID` to the gateway's device ID and `REMOTEA_GLASSFACE_SCOPE=visible-manual` in the **primary host** service environment. For Claude, set `REMOTEA_GLASSFACE_CLAUDE_BIN` to the versioned native executable used to launch the direct sessions. The gateway authenticates over the normal private host transport and identifies its app as `googleglass`. The server advertises `glassfaceSharedGroups` to that client and checks the foreground native agent before advertising each pane as writable. Hidden panes stay outside its roster. Eridani runs and shells remain view-only. Earlier configured single-group hosts continue to use `REMOTEA_GLASSFACE_GROUP_ID`.

Before activation, run `remotea status --json` using the primary host’s configuration. Check its server identity, health, boot ID, keeper observations and live session records. An idle agent in a PTY owned by the server will still end on restart. Defer activation until every in-process session has actually exited, including Eridani work. The upgrade command has no deferred-until-empty mode. Its drain waits for pending command and write operations. It does not wait for an open terminal to exit.

Arrange a quiet interval for new work. Recheck the live roster and keeper immediately before changing the service's release path. Use the existing `remotea upgrade --unit remotea` against that same configuration, with the actual primary service unit substituted when different. Leave off `--yes` so a newly discovered in-process session stops the upgrade. Compare server identity and keeper session incarnations with the pre-upgrade snapshot. From the authenticated gateway verify `glassfaceSharedGroups`, `sessionRecency`, a normal manual agent, and the read-only status of a shell or managed pane. Keep the old release available for rollback under the same preconditions.
