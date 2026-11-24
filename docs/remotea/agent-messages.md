# Sending a reviewed message to an open agent pane

A device on an authenticated Remotea connection can negotiate the `agentMessage` server feature. A desktop must be attached to the visible surface. The enrolled Glass gateway can address its visible manual sessions on the same host. Desktop keyboard input continues to use the normal PTY path.

1. Request `agentMessageTarget` with the surface ID and a request ID. A non-null target contains the host boot, surface incarnation, provider conversation and current prompt revision. Refresh it before capturing a new draft. A null result means the pane is unavailable for this operation.
2. Send `agentMessage` with that target, the surface ID, request ID, a unique `operationId`, and the confirmed plain-text message. Dani can bind a reply to an observed question by including its `turn`. The host checks that exact question again at dispatch.
3. A matching `agentMessageReceipt` with `queued` and a `providerMessageId` means the provider accepted the message for that thread. A guarded composer returns `submitted` after submitting the reviewed text. The subsequent provider response appears in the same desktop terminal. A retry with the original operation ID and body returns the original receipt during this host boot. A new boot invalidates the request.
4. On `uncertain` or `partial`, inspect the same conversation before drafting another message. An operation with ambiguous effects is never replayed. An existing desktop draft, approval dialog or changed question can produce `refused`. The caller can request a fresh target once the user resolves it.

For a native Codex process running under Bash, the host resolves the pane's foreground process and its single open root rollout. It probes that installed Codex binary for the local `queue --thread --message` command. It sends via the proven thread ID and verifies the returned provider receipt. A CLI without that capability leaves the Bash-backed pane view-only. Google Glass may also read recognized foreground Claude children. The installed Claude CLI lacks a verified way to inject a message into an existing interactive child by session ID. A directly launched Claude composer still accepts guarded input. Eridani-managed runs follow the separate run-controller API.

When Remotea restarts, the usual pane recovery can launch `codex resume <saved-thread>` under Bash. A resumed CLI can show its conversation while holding no rollout descriptor. For a conversation that this host recovered itself, the host checks the current foreground executable, exact resume arguments, process start time and provider-indexed root transcript. Glass can send its first follow-up immediately. Desktop keyboard input, a changed process or conflicting rollout evidence invalidates the startup binding. A directly observed current root rollout can still authorize input after that. Reattaching the desktop viewer does not itself change the conversation.

## Opt-in integration check

Build the remote server and run the following on a Linux host with an authenticated native Codex. Supply an already trusted directory. This starts a fresh in-memory Remotea host and a fresh, read-only Codex conversation in a new Bash terminal. It uses real model calls. It exercises a Glass send, a desktop send, same-operation retries, visible replies and the Glass reader. Set `REMOTEA_TEST_CODEX_MODEL` to override the fixture model.

```sh
npm --prefix remote-server run build
node remote-server/scripts/e2e-agent-message.cjs /absolute/path/to/trusted/project
```
