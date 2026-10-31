<!-- wmux:start — AUTO-MANAGED BY wmux. Do not edit this section manually. -->

# remotea

Remotea integration is optional context, written into a global agent file. You may
be in a desktop pane, a host terminal, an ordinary shell or CI. Identify the
endpoint available **in this shell** before choosing commands:

```bash
wmux identify
wmux capabilities
```

Read the returned `features` array. A desktop endpoint advertises `workspaces`,
`splits`, `notifications`, `windows`, `browser`, `markdown`, `agents` and `status`.
A host hook bridge advertises only `status`: it is not a desktop control endpoint.
A successful `wmux ping` (a legacy reachability probe) does **not** establish any
command capability; the host bridge need not implement ping at all.

If the commands answer anything else — command not found, an error, no output —
do not conclude yet. Outside panes, PATH may omit this install or name a different
program. In an ordinary desktop shell, try this install directly:

```bash
"{{WMUX_CLI_BIN}}/wmux" identify
"{{WMUX_CLI_BIN}}/wmux" capabilities
```

If these answer, use that absolute path instead of bare `wmux`. Do not redirect a
host session to an unrelated desktop or clear its `WMUX_REMOTE` / token context.
If discovery also fails, the endpoint is unavailable to this session. Use your
normal tools; failure does not prove the app or host is stopped. Nothing here is a
restriction on what you may otherwise do. Never print authentication tokens.

## Command scope

- Desktop endpoint: use only command families advertised by capabilities. Browser
  and markdown below require `browser` and `markdown` respectively; workspace,
  window and agent control require their corresponding features.
- Host status bridge (`features: ["status"]`): `wmux report-agent`,
  `wmux release-agent` and `wmux report-subagent` report in their session scope.
  `wmux agent-state` is a desktop query and is not relayed by the host bridge.
  Do not use browser, markdown, window or workspace control there. Missing browser
  support does not disable status reporting. Follow reported errors for unavailable
  status options; normal hooks may already report activity.
- Host administration: `remotea status`, `remotea doctor`, `remotea hooks status`
  and `remotea eridani status` are the **host CLI**, distinct from desktop `wmux`
  shims (the desktop package also has a `remotea` entrypoint). Inspect `--help` in
  that environment. Desktop `--remote` selects a desktop CLI TCP bridge, not a
  host session server WebSocket.
- Eridani-bound host session: use the supplied run/target context and configured
  Eridani MCP tools for task/run decisions, questions and verification. MCP
  availability is stated in the run context; do not infer it from agent status.
  Agent activity, process exit and task acceptance are different facts.

## Browser

When the endpoint advertises `browser`, the desktop browser commands provide a
shared view the user can watch. Prefer that view when it helps the task; respect
the user's explicit tool preference. When this capability is absent, use normal
browser tools. The browser runs on the desktop computer; `localhost` refers there,
not to a host terminal's machine. Use a reachable host URL or configured tunnel.

```bash
wmux browser open <url>          # navigate
wmux browser snapshot            # get accessibility tree with eN refs
wmux browser click eN            # click element
wmux browser type eN <text>      # type into element
wmux browser fill eN <value>     # set input value
wmux browser get-text            # get page text
wmux browser screenshot          # capture screenshot
wmux browser eval <js>           # run JavaScript
wmux browser back                # go back
wmux browser forward             # go forward
wmux browser reload              # reload page
wmux browser <verb> --surface <id>   # drive a specific pane's browser
```

Workflow: `browser open <url>` → `browser snapshot` → read tree → `browser click/type eN` → `browser snapshot` again.

Refs (`e1`, `e2`...) expire after page changes — always re-snapshot.

## Markdown (desktop `markdown` capability)

To let the user review a markdown document — your plan-mode plan, a spec, a design doc, a README — open it in a read-only markdown view (like the diff view) instead of dumping it into the terminal:

```bash
wmux markdown <file>             # open a .md/.markdown/.mdx/.txt/.rst file in a new markdown view
wmux markdown set <id> --content "# Title\n..."   # set content of an existing markdown surface
wmux markdown set <id> --file <path>              # load a file into an existing markdown surface
wmux markdown set <id> --content "..." --title T # label the tab (pushed content stays pathless)
wmux markdown get <id>                           # read a surface's buffer back out
```

Relative paths resolve against your current working directory. Only text/markdown files up to 5 MB are accepted. Prefer this over pasting long markdown into the terminal so the user can read it comfortably in a pane.

## Asking the user something (`status` capability)

When you stop to ask the user a question — a permission prompt, a choice, a
confirmation — tell remotea, and tell it what the answers are. The sidebar then
shows **"Needs you"** on your pane (so a user with ten panes open can see which
one is waiting), and renders your answers as buttons they can click **without
switching to your pane**.

```bash
wmux report-agent --blocked "Run the migration against prod?" --choices '[
  {"id":"yes","label":"Yes, run it","key":"1"},
  {"id":"no","label":"No, stop","key":"2","isDefault":true}
]'
```

Each choice needs an `id`, a human-readable `label`, and **exactly what to send**
— either `key` (a key name: `enter`, `esc`, `1`, `y`, …) or `text` (sent
literally). remotea relays those bytes verbatim; it does not know how to answer
your prompt and will never guess. A choice with neither is dropped, and the
reply tells you how many were kept.

Answering does **not** clear your blocked state — report it yourself once you
have acted on the answer, exactly as you would if the user had typed it:

```bash
wmux report-agent --unblocked
```

## Subagents and background tasks (`status` reporting)

Claude Code's own subagents appear under your pane in the sidebar on their
own. If you run work of your own in the background — a worker, a planner, a
long task that outlives your turn — declare it, so the pane does not read idle
while it runs. Same id to update (each call is a heartbeat), `--done` to finish:

```bash
wmux report-subagent planner-1 --name planner --detail "calling create_file"
wmux report-subagent planner-1 --done
```

<!-- wmux:end -->
