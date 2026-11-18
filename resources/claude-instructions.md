<!-- remotea:start — AUTO-MANAGED BY remotea. Do not edit this section manually. -->

# remotea

Remotea integration is optional context, written into a global agent file. You may
be in a desktop pane, a host terminal, an ordinary shell or CI. Identify the
endpoint available **in this shell** before choosing commands:

```bash
remotea identify
remotea capabilities
```

Read the returned `features` array. A desktop endpoint advertises `workspaces`,
`splits`, `notifications`, `windows`, `browser`, `markdown`, `agents` and `status`.
A host hook bridge advertises only `status`: it is not a desktop control endpoint.
A successful `remotea ping` (a legacy reachability probe) does **not** establish any
command capability; the host bridge need not implement ping at all.

If the commands answer anything else — command not found, an error, no output —
do not conclude yet. Outside panes, PATH may omit this install or name a different
program. In an ordinary desktop shell, try this install directly:

```bash
"{{REMOTEA_CLI_BIN}}/remotea" identify
"{{REMOTEA_CLI_BIN}}/remotea" capabilities
```

If these answer, use that absolute path instead of bare `remotea`. Do not redirect a
host session to an unrelated desktop or clear its `REMOTEA_REMOTE` / token context.
If discovery also fails, the endpoint is unavailable to this session. Use your
normal tools; failure does not prove the app or host is stopped. Nothing here is a
restriction on what you may otherwise do. Never print authentication tokens.

## Command scope

- Desktop endpoint: use only command families advertised by capabilities. Browser
  and markdown below require `browser` and `markdown` respectively; workspace,
  window and agent control require their corresponding features.
- Host status bridge (`features: ["status"]`): `remotea report-agent`,
  `remotea release-agent` and `remotea report-subagent` report in their session scope.
  `remotea agent-state` is a desktop query and is not relayed by the host bridge.
  Do not use browser, markdown, window or workspace control there. Missing browser
  support does not disable status reporting. Follow reported errors for unavailable
  status options; normal hooks may already report activity.
- Host administration: `remotea status`, `remotea doctor`, `remotea hooks status`
  and `remotea eridani status` run the **host CLI**. The same `remotea` command
  picks its program by where it runs: inside a remotea terminal the commands above
  reach that terminal's endpoint, and a verb only the host knows is passed on to
  the host CLI. `remotea token` inside a terminal prints the endpoint's token, not
  the host admin token. Inspect `--help` in that environment. Desktop `--remote`
  selects a desktop CLI TCP bridge, not a host session server WebSocket.
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
remotea browser open <url>          # navigate
remotea browser snapshot            # get accessibility tree with eN refs
remotea browser click eN            # click element
remotea browser type eN <text>      # type into element
remotea browser fill eN <value>     # set input value
remotea browser get-text            # get page text
remotea browser screenshot          # capture screenshot
remotea browser eval <js>           # run JavaScript
remotea browser back                # go back
remotea browser forward             # go forward
remotea browser reload              # reload page
remotea browser <verb> --surface <id>   # drive a specific pane's browser
```

Workflow: `browser open <url>` → `browser snapshot` → read tree → `browser click/type eN` → `browser snapshot` again.

Refs (`e1`, `e2`...) expire after page changes — always re-snapshot.

## Markdown (desktop `markdown` capability)

To let the user review a markdown document — your plan-mode plan, a spec, a design doc, a README — open it in a read-only markdown view (like the diff view) instead of dumping it into the terminal:

```bash
remotea markdown <file>             # open a .md/.markdown/.mdx/.txt/.rst file in a new markdown view
remotea markdown set <id> --content "# Title\n..."   # set content of an existing markdown surface
remotea markdown set <id> --file <path>              # load a file into an existing markdown surface
remotea markdown set <id> --content "..." --title T # label the tab (pushed content stays pathless)
remotea markdown get <id>                           # read a surface's buffer back out
```

Relative paths resolve against your current working directory. Only text/markdown files up to 5 MB are accepted. Prefer this over pasting long markdown into the terminal so the user can read it comfortably in a pane.

## Asking the user something (`status` capability)

When you stop to ask the user a question — a permission prompt, a choice, a
confirmation — tell remotea, and tell it what the answers are. The sidebar then
shows **"Needs you"** on your pane (so a user with ten panes open can see which
one is waiting), and renders your answers as buttons they can click **without
switching to your pane**.

```bash
remotea report-agent --blocked "Run the migration against prod?" --choices '[
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
remotea report-agent --unblocked
```

## Subagents and background tasks (`status` reporting)

Subagents that remotea already tracks through your agent's integration appear
under your pane in the sidebar on their own. If you run work of your own in
the background — a worker, a planner, a long task that outlives your turn —
declare it, so the pane does not read idle while it runs. Same id to update (each call is a heartbeat), `--done` to finish:

```bash
remotea report-subagent planner-1 --name planner --detail "calling create_file"
remotea report-subagent planner-1 --done
```

<!-- remotea:end -->
