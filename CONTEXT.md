# remotea

remotea is a desktop terminal app for coding agents, organized around workspaces, split panes and tabs. Its terminals run either on this computer or on a remote host. This glossary keeps the words for those things precise.

## Language

**Workspace**:
A named set of panes shown in the main window and listed in the sidebar. Each workspace has its own split tree.
_Avoid_: Project, session, window

**Pane**:
A rectangular region in a workspace's split tree that holds one or more surfaces as tabs.
_Avoid_: Console window, tab

**Surface**:
A single terminal, browser, markdown or diff instance shown as a tab inside a pane. A surface is dragged by its tab title.
_Avoid_: Console window, terminal window, panel

**Live Layout Preview**:
The temporary workspace layout shown while a surface tab is dragged, matching what would exist if the surface were dropped at the current target.
_Avoid_: Drop zone highlight, ghost split preview, preshow

**Remote host**:
A machine running the remotea session server that this app connects to, set up in Settings → Remote hosts. WSL on this same PC counts as one. A surface launched with `remote:<host>` runs there.
_Avoid_: Remote (alone), server, box

**Remote session**:
A terminal that lives on a remote host. It keeps running while the app is disconnected, as long as the host and its session server stay up, and the app reattaches to it.
_Avoid_: Remote terminal, remote tab

**Session server**:
The `remote-server/` program on a remote host. It owns that host's terminals and the agent state reported from them.
_Avoid_: Backend, daemon

**Remote Console**:
The phone web page for watching and answering agent panes, served by the desktop app. It has nothing to do with remote hosts.
_Avoid_: Remote (alone), mobile app
