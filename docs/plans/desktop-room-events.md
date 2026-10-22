# Push from rooms to an operator session

Status: design proposal for #169, checked 2026-10-22. No observer registration,
MCP event server or desktop delivery described here is implemented yet. Existing
visitor replies remain durable and pull-based.

## What can actually start a turn

| Target | Evidence and boundary | Integration to test |
| --- | --- | --- |
| ChatGPT Work, Cloud | [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events) delivers signed webhook events to subscribed Work web chats, desktop Work chats with Cloud selected, and dots. The user specifies the response. It requires MCP 2.0, persistent subscriptions and callback verification. A successful HTTP response is receipt, not completed model work. | A tt MCP/plugin bridge with filtered subscriptions and signed callbacks. An authenticated reachable endpoint, using a relay or a supported tunnel to the local bridge, needs end-to-end acceptance. |
| ChatGPT Work, This computer | The MCP Events page does not establish support for local chats. | Keep this capability unproven; do not claim the Cloud route wakes a local conversation. |
| Codex clients | [App-server `turn/start`](https://learn.chatgpt.com/docs/app-server#start-a-turn) can start a turn in a specified thread. That API alone does not prove an external process can reach the exact thread displayed in the user's desktop client. | Reuse an explicitly registered local endpoint and exact thread identity; verify idle delivery and desktop visibility in a disposable session. |
| Claude Desktop, Code tab | [Cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging) documents a session inbox and idle-turn wake, including Desktop Code sessions. Inbound permission policy can hold a message. Script-to-own-session support is documented; an unrelated bridge process reaching a registered desktop session still needs acceptance. | Extend the existing Claude inbox adapter to opted-in operator endpoints, without adding room membership. Validate process start and session identity; preserve inbound policy. |
| Claude Code terminal | [Channels](https://code.claude.com/docs/en/channels) is a research-preview MCP push mechanism for a running Claude Code session. It has authentication, organization and explicit-enablement requirements; this does not establish ordinary Claude desktop chat support. | A separate channel adapter, tested with the actual client and enabled channel. |
| Ordinary Claude chat; Grok desktop | No supported external trigger into an existing desktop conversation was established. [Grok's scripting docs](https://docs.x.ai/build/cli/headless-scripting) describe client-driven headless and ACP prompts, which do not prove desktop delivery. | Report unsupported/unverified. Optional OS notification lets the human reopen a room; it does not wake a model. |

Generic MCP tool/resource notifications alone do not establish a model-turn
trigger. Use the client's documented event extension or a verified native inbox.
No terminal keystroke or desktop UI automation is the default transport.

## Common contract

Keep the CLI and room database authoritative. Add an optional event bridge over
them; MCP is an adapter, not a replacement for the CLI or the observer skill.

1. The operator explicitly registers the current session as an **observer**,
   selecting rooms, event types and lifetime. Store an opaque observer ID and
   the verified endpoint/thread identity separately from room members. Registering
   never joins, claims, changes presence or grants additional room authority.
   Run registration inside that session and read its own exported socket/token
   or thread ID. Do not scrape other sessions' files or guess the foreground
   conversation. Keep endpoint tokens in a private 0600 file.
2. A room member can address that observer explicitly, or answer an existing
   visitor request whose requester opted into push. Default subscriptions deliver
   directed answers, blockers and requests for decisions, rather than every room
   message or tool step. The user can choose broader monitoring.
3. Commit the source message and an outbox record atomically. For local native
   inboxes, reuse sender-side delivery: the tt process committing the message can
   attempt it immediately, as current member wakes do. No new always-running
   process is required for that path. A bridge supplies continuous retry while
   no tt process is running, and hosts the MCP subscription/callback adapter.
   It watches committed events with a durable cursor; no assistant polls or runs
   merely to check for work. On restart, resume without skipping unsent events.
4. Store delivery per observer and source event. Include room ID, canonical path,
   event sequence, sender and correlation ID. Send a bounded excerpt and a read
   reference for large content. The receiver treats message bodies as source
   data, with the sender's authority, never as system instructions.
5. Apply the destination's opt-in wake policy: coalesce bursts, cap wake frequency,
   expire subscriptions and bound retries. Preserve event IDs on retries. A
   transport acceptance, a recorded receiver receipt and an assistant reply are
   separate states; do not infer reading from any one of them.
6. The desktop assistant replies through the existing visitor request/reply path
   or an explicitly correlated message. Subscription rules exclude its own
   reflected output, so one exchange cannot create an automatic wake loop.
   Stopping monitoring revokes future delivery and discards queued wake attempts.

Endpoint secrets belong in private local storage and never in room messages,
logs, skills or event payloads. Cloud callback delivery must follow the provider's
signature, verification and destination-validation rules. A session replacement
invalidates a local registration; do not guess another desktop thread.
Claude's inbound policy can hold peer messages, including in permission-bypass
sessions; an operator may explicitly select `crossSessionInbound: accept`.
Report held/queued separately and never change that policy silently.

The `talking-stick-rooms` skill should eventually register the current observer
when asked to monitor, explain the selected wake scope, and expose stop/status.
It should continue using list/brief/ask/replies for ordinary one-shot questions.
Proposed command names and persistence schema belong in the implementation PR,
after a disposable endpoint test proves each adapter.

## Delivery sequence and acceptance

First test an opted-in Claude Desktop Code session, then an exact registered Codex
thread. Separately rehearse ChatGPT MCP Events through the authenticated bridge;
Cloud subscription is an explicit product choice, not an invisible switch from
local execution. Keep unproven clients on the durable inbox with an optional
human notification.

For each adapter, prove: idle arrival without a user prompt or client poll; busy
delivery; a visible response in the intended conversation; a reply arriving back
in the originating room; duplicate suppression; bounded burst delivery; recovery
after bridge restart; expiration/unsubscribe; and no delivery to a replacement
session. Test failed/ambiguous delivery without claiming it was definitely unsent.
Do not promise availability until these client-specific checks pass.
