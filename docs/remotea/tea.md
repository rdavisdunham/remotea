# Tea research and implementation design

Research date 2026-11-07.

Tea is Remotea's server-backed assistant. Its first release covers terminal discovery, concise work summaries, automatic terminal names and ordinary workspace management. The user selected a separate assistant identity, API-key connections and independently configurable conversational and background models. Anthropic Sonnet and Haiku are the initial model choices.

## Research method

Exa returned 45 candidate search hits across provider behavior, harness and context design, durable execution, and evaluation and security. Eighteen primary source pages were fetched. First-party documentation and engineering reports carried the decisions. Framework documentation supplied replay and checkpointing principles. Coding-agent studies were treated as evidence about long-lived state and evaluation, with Tea's smaller application-management workload assessed separately.

## Findings and their application

### Keep the execution model understandable

Anthropic describes successful agents as composable model-and-tool loops and recommends increasing orchestration complexity when measured outcomes justify it. Its later application-building research adds structured handoffs, incremental progress and independent outcome checks for longer work. Tea can use a server-owned loop over official provider APIs, backed by Remotea's existing persistence and operations. Background naming and summarization have a fixed input/output contract and fit a single bounded request. Conversational actions use a small iterative tool loop. [Agent design](https://www.anthropic.com/research/building-effective-agents), [Long-running application harnesses](https://www.anthropic.com/research/harness-design-long-running-apps)

### Treat tools as an application interface

Tool descriptions should explain purpose, inputs, scope and useful outputs. Overlapping tools and oversized results make correct selection harder. Tea tools should use stable session and workspace IDs, descriptive results and bounded excerpts. The same underlying registry operations should serve desktop actions and Tea actions. Each successful mutation returns the resulting server state so the assistant can ground its reply in an observed outcome. [Tool design](https://www.anthropic.com/research/writing-tools-for-agents)

### Retrieve terminal detail when needed

Context engineering guidance favors compact references and targeted retrieval. Tea should begin with a bounded inventory containing names, work summaries, directory, activity, origin and freshness. It can retrieve a relevant terminal's recent captured turns through a tool. Shell-only terminals can describe their observed directory. Generated summaries should describe the evidence available and expose source freshness. [Context engineering](https://www.anthropic.com/research/effective-context-engineering-for-ai-agents)

### Use provider-specific adapters

OpenAI's current function-calling documentation says GPT-6 Astra and GPT-6.1 Sol require Responses for tool calling. A native OpenAI adapter therefore uses Responses. Gateways can explicitly select an OpenAI-compatible Chat Completions protocol. Anthropic uses Messages. Each adapter preserves its complete replayable output, tool-call identities and provider-specific content blocks. OpenAI documents preserving reasoning items and assistant phase values. Those opaque fields belong in private protocol state. The UI renders the public conversation and tool outcomes. [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling), [OpenAI conversation state](https://developers.openai.com/api/docs/guides/conversation-state)

### Validate actual model capabilities

Both vendors expose model-listing endpoints. Anthropic additionally documents capability fields. OpenAI's list is primarily identity and availability metadata. Discovery therefore populates choices, while a selected-model test checks actual generation and tool calling. A gateway can support manual model entry when its catalog is unavailable. Connection settings include a protocol, base URL and key. Keys are credentials and do not identify an API protocol reliably. [Anthropic discovery](https://platform.claude.com/docs/en/api/models/list), [OpenAI discovery](https://developers.openai.com/api/reference/resources/models/methods/list)

### Configure Sonnet and Haiku according to their current APIs

Sonnet 5.5 rejects sampling parameters such as temperature, manual thinking budgets, assistant prefill, forced named/any tool choice and disabled thinking. Its documented baseline uses automatic tool choice and an effort setting. Medium effort is a sensible starting point for Tea's conversational workload, subject to evaluation. Haiku 5.5 documents low effort for simple high-volume tasks and permits disabled thinking at supported effort levels. That makes low-effort structured naming and summarization a useful initial profile. Model discovery and validation must keep custom or older models from inheriting unsupported options. [Sonnet migration guide](https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide), [Haiku prompting guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-haiku-5-5)

### Use schemas and inspect completion conditions

Both vendors document schema-constrained generation. The background request should return an object containing a short title and a brief work summary. Tool inputs and model outputs also need application-side validation. Refusals, incomplete generation and truncated arguments need explicit outcomes. Tool execution should start only after a complete, validated call has been received. [Anthropic structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs), [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)

### Persist action receipts across crashes

A checkpoint does not make every external side effect exactly once. Framework documentation explains that replay can run interrupted work again, so effects need stable operation IDs and reconciliation. OpenAI likewise recommends saving function results by session, turn and call ID and checking uncertain effects before replay. Tea should save each requested action, apply an idempotent registry operation, then save its result before asking the model to continue. A restart exposes interrupted work and resumes from confirmed boundaries. Focus requests carry a requesting-device identity and a delivery result. An interrupted navigation request is surfaced as uncertain. [Durable execution](https://docs.langchain.com/oss/javascript/langgraph/functional-api), [Function recovery](https://developers.openai.com/api/docs/guides/agents-api/tools/functions), [Durable pauses](https://docs.langchain.com/oss/javascript/langgraph/interrupts)

### Bound requests and preserve cancellation

Official SDK documentation describes streaming, cancellation and automatic retries. Tea needs explicit request deadlines, bounded model/tool iterations, a separate background queue and rate-limit handling. A transient provider retry must preserve completed application effects. Background work should coalesce by terminal and evidence version. The user-facing status should distinguish model generation, tool work, queued input, interruption and provider errors. [OpenAI TypeScript SDK](https://developers.openai.com/api/reference/typescript)

### Keep terminal content in the data channel

Anthropic recommends keeping retrieved content in tool results, identifying its source and treating embedded directions as untrusted content. Tea's application policy and available tools come from the server. Captured terminal text is evidence for search and summaries. Credential storage stays outside the model context and shared client snapshots. Existing redaction should cover captured text and diagnostics. [Prompt-injection guidance](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/mitigate-jailbreaks)

### Evaluate real outcomes

Agent evaluation guidance distinguishes what an assistant says from the resulting application state. Tea's tests should inspect selected terminals, persisted names, reminders and synchronized snapshots. A small task-grounded regression set can catch failures early. Provider contract fixtures should cover reasoning and tool blocks, incomplete responses, malformed inputs, unsupported capabilities, errors and model discovery pagination. Live model quality checks become available after the operator configures a provider credential. [Agent evaluation guidance](https://www.anthropic.com/research/demystifying-evals-for-ai-agents)

## Product behavior

### Shared host assistant

The server owns Tea's configuration, conversation, action receipts, captured terminal context and generated summaries. Each connected desktop can read the same host conversation. Inputs have stable IDs and serialize into one conversational queue. A status and retry/stop controls explain interrupted work. Navigation requests target the requesting device. Renames and reminders use the server's existing shared-state semantics.

### Connections and model roles

Settings expose connection profiles with a display name, protocol, base URL and write-only API-key field. Anthropic Messages, OpenAI Responses and an OpenAI-compatible Chat Completions option are supported. The server returns masked connection readiness. The Test connection action checks authentication and discovers models. Model-role validation tests structured output for background jobs and tool calling for conversation. Roles select a connection and model independently. Initial suggestions are Sonnet for conversation and Haiku for background work.

Private provider files use the host's existing protected configuration directory. Credentials remain server-side. Updating a key or endpoint invalidates previous validation. Redirects and error messages must preserve credential boundaries. Settings changes are revisioned so concurrent devices receive an explicit conflict rather than silently overwriting newer settings.

### Names and summaries

Generated titles and user-selected titles are separate fields. The server continues treating existing explicit titles as user choices. A custom rename from any device, or an explicit rename requested through Tea, takes precedence. Use automatic name clears that override. Generation jobs recheck the session's identity, source version and manual naming state before applying results. A custom title continues to permit updated work summaries.

Generate the initial name, display summary and rolling memory after the first captured exchange. After that, wait for ten further root exchanges per terminal before another background request. One schema-constrained request updates all three fields. A root Stop contributes one exchange, including an interim reply while background tasks continue. Duplicate turn IDs and synthetic background hand-backs leave the batch count unchanged. Explicit refresh and background configuration changes can request an earlier update.

Private host evidence retains the latest ten redacted exchanges, each with up to 4,000 characters of prompt and reply, plus rolling memory of up to 200 words and 2,000 characters. Generation receives the previous memory and recent exchanges together. Preserve the overall goal, important decisions, unresolved issues and current progress while allowing new evidence to correct earlier assumptions. Search and read tools use memory and recent exchanges between generation calls. Rapid captures coalesce into this bounded recent window.

Persist source-local exchange counts and the count covered by the memory. A completed background request can publish its captured prefix while newer exchanges remain in the next batch. Restart restores both context and batching, and resumes batches already due. Older saved evidence seeds its first rolling memory from the existing same-conversation display summary and captured excerpt. A new harness conversation starts its own context and count. Provider errors retain the previous memory and pending recent evidence for explicit refresh or later capture-driven retry.

Store the title, summary, source identity, generated time and source time. The sidebar shows a one-sentence summary and a recent-activity marker for exchanges newer than that summary. Opening an app reads cached summaries. A custom name remains authoritative while generated context continues to update.

### Initial tools

| Tool | Application operation |
|---|---|
| Search terminals | Rank host sessions using names, summaries, repository and recent captured evidence |
| Read terminal context | Return a bounded, redacted excerpt with source and freshness |
| Open terminal | Ask the requesting device to select the matching existing terminal |
| Rename terminal | Apply an explicit custom title through the registry |
| Rename workspace | Update the existing shared workspace name |
| Move terminal | Move a session to an existing host workspace |
| Mark unread | Use the existing attention service for the requesting device |
| Set reminder | Use the existing server-backed reminder service |

Tools validate session and workspace identities at execution time. Their results expose confirmed effects and actionable failures. Tea's routine management actions use the operator's authorized application scope. Existing Eridani controller ownership continues to govern harness input.

## Verification and delivery

1. Add shared types and host protocol operations, preserving older clients' behavior.
2. Implement private connection storage, discovery and capability tests.
3. Implement provider adapters with complete wire-state preservation and bounded cancellation.
4. Implement durable conversation and action receipts using existing host persistence patterns.
5. Connect captured prompts and turns to coalesced background jobs.
6. Add server-owned generated metadata and race-safe custom naming behavior.
7. Add the Tea panel, settings and terminal summaries through existing desktop IPC and host synchronization.
8. Add targeted provider, replay, naming-race, multi-device and UI regression coverage.
9. Run server tests, app checks, production builds and the repository CI gates.
10. Merge after green CI and activate the server update with session recovery checks.

The first live provider verification requires a configured API key. Connection tests and model choices expose that requirement in the app.

## Setup and operating limits

Tea starts disabled. Configure it in Settings → Tea, choose the host and save a connection, discover models and run the selected-model tests. Enable Tea after choosing the models. A provider catalog failure still permits manual model entry. Compatible gateways must support the selected schema and tool contracts to pass validation.

One conversational loop processes up to twelve queued messages. Each turn has a ten-round limit and each model request has a ninety-second deadline. Explicit continuation gives an interrupted turn a new round budget while preserving saved action receipts. Summary requests have a forty-five-second deadline, use a separate coalesced queue and return bounded title and summary fields. SDK transient retries share the request deadline and happen before application actions execute.

The host keeps up to 300 recent public messages, exposes the latest 180 to apps, and retains the current replayable provider segment. A fresh segment begins after a model profile change or when the saved wire context exceeds 96,000 characters. A history-search tool retrieves earlier retained public messages. Raw provider reasoning and API credentials stay in private host state. General terminal text passes through the existing redactor and an additional configured-key redaction pass.

API keys live in a permission-restricted local file under the host's configuration directory. They are available to the account running the host service. Saving a removed provider profile deletes its credential. Remove saved key explicitly clears the credential while retaining the connection. Settings and model tests make billable provider calls. The first release has bounded job sizes and queues. Spending limits can also be managed in the chosen provider account.

The test suite uses synthetic provider responses and terminal evidence. Real provider authentication, access and model quality are verified through the app after the operator supplies a key.

## Verification results

The full Linux server suite passed with 981 tests. The selected client transport, naming, host integration and UI suites passed with 122 tests. App and server typechecks, main/preload compilation, renderer production bundling and server compilation also passed.

An isolated Windows Electron app connected to a test server and a synthetic Anthropic-compatible endpoint. It verified the complete desktop-to-provider path for model discovery, structured output and tool-result replay. Captured terminal hooks produced a shared name and summary. An explicit custom name remained authoritative. Sending a real panel message exercised terminal search and returned an actionable terminal link. The panel and send controls fitted within the desktop viewport. This fixture check used a synthetic key and synthetic model responses.

Real account authentication, model availability and response quality require the operator's configured API key. The built-in tests cover authentication, generation contracts and replay. Human review of initial live summaries and terminal selections will establish the quality baseline for the chosen models.

## Reply streaming

Conversational requests stream public text through the native provider SDK helpers for Anthropic Messages, OpenAI Responses and compatible Chat Completions. The helpers also produce the complete final response for validated tool execution and provider-state replay. Conversational capability checks exercise streaming tool calls and result replay.

The host coalesces redacted preview updates at 100 ms intervals and checkpoints active text approximately once per second. Final response state, cancellation and interruption flush the saved message state. Reconnecting apps receive the current partial reply through their initial host snapshot. Older desktops receive periodic complete state snapshots.

A partial reply has a stable message ID. An interrupted request preserves its readable draft, and an explicit retry replaces that draft. Incomplete streams cannot authorize tool execution. Stream rendering shows Thinking before visible text, Responding during output and an interrupted-partial label after interruption. Auto-scroll follows new output while the reader is near the bottom. Animation respects reduced-motion preferences.

Preview redaction waits for complete words and handles configured credentials across chunk boundaries. Provider reasoning and tool argument fragments remain in private adapter state until a complete response is available. Native provider references are [OpenAI streaming](https://developers.openai.com/api/docs/guides/streaming-responses) and [Anthropic streaming](https://platform.claude.com/docs/en/build-with-claude/streaming).
