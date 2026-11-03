# Chat attention and reminders

Each terminal chat has an activity status and a separate unread state:

- **Working on it…**: the agent reports an active turn.
- **Finished** (green): a turn just ended. After four seconds, an unseen reply shows **Unread · check this chat** (orange).
- **Needs you** (violet): the agent is waiting for input. Reading the chat does not answer or approve it.
- **Idle · ready for you** (green): the chat is idle and its latest attention event has been read.
- **Status unavailable**: no reliable activity state is available. Disconnects show an offline label with the last known status.

Unread chats have an orange tab dot/underline and an unread-chat count in their workspace row. A newly arrived reply remains unread even if its pane already has focus. Clicking its tab, switching focus to it, or interacting with its terminal marks that reply read. Hidden sibling tabs are unaffected. Use **Mark unread** in the status bar or tab context menu to keep it on your list.

Remote unread state lives in the server registry and is acknowledged separately per device. Every attention event has a revision: an acknowledgement for an older reply cannot clear a newer one. Local terminals use a bounded local attention cache. Accurate activity depends on the existing agent status hooks and screen detection; silence alone never declares a turn finished.

## Reminders

Use **Remind me…** in a remote terminal's status bar or tab menu. Choose 10, 30, or 60 minutes, or a specific local date/time, and optionally add notes. One reminder can be scheduled per chat; setting another replaces it. Edit or remove it from the same control. Times are stored as absolute timestamps; the time picker and display use the app device's timezone.

The session server stores and runs reminders without an Eridani account or cloud scheduler. At the due time the chat becomes unread and connected apps receive its updated registry record. Remotea uses its existing desktop notification settings to show a reminder once per device. If the app is closed, the reminder is delivered on reconnect. If the server is off, overdue reminders fire at startup. Reading a reminder leaves it available to edit or reschedule and removes its due indicator. Closing the session deletes its reminder. A pending reminder protects an exited session from normal retention cleanup until its creator acknowledges it or it is removed.

Scheduling and changes require a connected server. No success is shown until the server confirms the write. Uncertain responses prompt the user to inspect the current state before retrying. Older servers show an update message and continue running terminals normally.

## Future Eridani integration

`ChatAttentionService` owns scheduling and durable state independently from the UI and harness. Its publication callback and the additive `chatAttention` protocol capability provide an extension point for an opt-in Eridani adapter later. This release sends no reminder data to Eridani, creates no Eridani tasks, and never writes to a terminal or changes run ownership when a chat is read, marked unread, or reminded.
