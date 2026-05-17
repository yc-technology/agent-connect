# Message Handling

## Message Queue Architecture

Per-user message queues + worker pattern for all send tasks:
- Messages are sent in receive order (FIFO)
- Status messages always follow content messages
- Multi-user concurrent processing without interference

**Message merging**: The worker automatically merges consecutive mergeable content messages on dequeue:
- Content messages for the same window can be merged (including text, thinking)
- tool_use breaks the merge chain and is sent separately (message ID recorded for later editing)
- tool_result breaks the merge chain and is edited into the tool_use message (preventing order confusion)
- Merging stops when combined length exceeds 3800 characters (to avoid pagination)

## Status Message Handling

**Conversion**: The status message is edited into the first content message, reducing message count:
- When a status message exists, the first content message updates it via edit
- Subsequent content messages are sent as new messages

**Polling**: Background task polls terminal status for all active windows at 1-second intervals. Send-layer rate limiting ensures flood control is not triggered.

**Deduplication**: The worker compares `last_text` when processing status updates; identical content skips the edit, reducing API calls.

## Rate Limiting

- Telegram sends go through the TypeScript message queue and sender helpers.
- On 429, send helpers honor Telegram retry timing before continuing.
- Status polling skips enqueueing duplicate status text and avoids adding status work when a queue is already busy.
- The default visible behavior is one temporary `Thinking...` status followed by the final answer.

## Performance Characteristics

**Event-driven, not polled.** Transcript reads are triggered by hook events (`SessionStart`, `PostToolUse`, `PostToolBatch`, `PostToolUseFailure`, `UserPromptSubmit`, `Stop`, `SessionEnd`). `drainTranscript` reads only `[last_byte_offset, file_size)` for the session named by the hook payload — no mtime cache, no directory scan.

**Per-session serialization.** `SessionRegistry.withSessionLock(sessionId, fn)` ensures only one drain per session runs at a time; concurrent events for the same session queue, then re-check `last_byte_offset` so the second caller is a cheap no-op. Different sessions drain in parallel.

**Per-window event ordering.** `HookRouter` maintains a `Map<windowId, Promise>` queue, so `SessionStart` always completes before any subsequent event for the same window even if the HTTP POSTs race.

**Truncation handling.** If `stat().size < last_byte_offset` the lock resets `last_byte_offset = 0` and evicts in-memory `pendingTools` before re-reading.

## No Message Truncation

Historical messages (tool_use summaries, tool_result text, user/assistant messages) are always kept in full — no character-level truncation at the parsing layer. Long text is handled exclusively at the send layer: `split_message` splits by Telegram's 4096-character limit; real-time messages get `[1/N]` text suffixes, history pages get inline keyboard navigation.
