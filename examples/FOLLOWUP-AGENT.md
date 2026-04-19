# Follow-up agent (MVP)

**Pitch:** When looking at the overall problem statement, I was pushed to ask: what can iMessenger-Kit do that OpenAI/Anthropic existing APIs cannot? And furthermore, what useful functionalities can be built from those capabilities.
I found that an automated reminder system to be the most compelling possibility that is not already extant within current APIs -- the ability to schedule future reminders and check-ins is very powerful.

This is a **MVP** built on `@photon-ai/imessage-kit`, **Bun**, **Claude** (Anthropic SDK), **`Reminders`** for scheduling, and **local SQLite** for follow-up rows. It runs as a **DM-only** bot: you text it from your phone (or another Mac), it replies in that 1:1 thread.

## Example conversation

**You:** remind me to follow up with Sarah about the promotion Thursday morning  

**Agent:** Got it — I’ll nudge you Thursday at 9am to follow up with Sarah (+15551234567) about the promotion. Reply yes to lock it in or no to cancel.  

**You:** yes  

**Agent:** Done. I’ll ping you Thursday.  

*(Thursday, scheduled reminder fires — see `llms.txt` for supported time strings like `thursday 9am`.)*  

**Agent (reminder):** ⏰ Reminder: Follow-up: touch base with Sarah about “the promotion”. Reply yes if you want a draft message to send them.  

**You:** yes  

**Agent:** *(draft)* Hey Sarah, wanted to check in about the promotion we talked about — any updates on your end?  

Want me to send this, or say skip / try again?  

**You:** send  

**Agent:** Sent to Sarah. Good luck.  

## Run

```bash
export ANTHROPIC_API_KEY=...
# optional: ANTHROPIC_MODEL=claude-sonnet-4-20250514
# optional: FOLLOWUP_DB_PATH=/path/to/followups.sqlite  (default: ./.followup-agent.sqlite)
# optional: RECIPIENT=+15551234567  — startup ping so you know which thread to use
export IMESSAGE_DEBUG=1   # optional
bun run examples/18-follow-up-agent.ts
```

Requires **macOS**, **Full Disk Access** for the terminal running Bun, and **Messages** signed in.

## What works (MVP)

- Capture follow-up intent from a DM (plus lightweight keyword gate to avoid sending every casual message to Claude).
- Resolve the contact using `sdk.listChats({ kind: 'dm', search, sortBy: 'recent' })` plus a short Claude pass when there are several DM matches.
- Confirm with yes/no before scheduling.
- Schedule the nudge with `Reminders.exact()` / `Reminders.at()` and persist `reminder_task_id` + metadata in SQLite.
- On nudge, offer a draft (second Claude call); then **send / skip / try again** (send uses `sdk.send(contact_phone, draft)`).
- If the user never engages after the nudge, a **second ping ~24h later** is scheduled; if that fires and the follow-up still isn’t completed, the row is **archived**.

## What's next:

- **Time strings** must work with the kit’s reminder parser (`"friday 2pm"`, `"tomorrow 9am"`, etc. — see root `llms.txt`). Vague phrases like “Thursday morning” are normalized to a default hour (e.g. 9am) before parsing; wrong guesses should be fixed in v2 with explicit time confirmation.
- **No recurring** follow-ups, **no** attachments, **no** rich multi-turn editing (beyond “try again” → regenerate).
- **One user / one process** assumption: in-memory conversation state is keyed by your DM `participant` handle; restart loses in-flight confirm/draft flow (SQLite still holds scheduled rows, but the bot may not resume the exact conversational step without more logic).
- **Contact disambiguation** is deliberately thin: if nothing matches, the bot asks for a phone or email you can use with `sdk.send()`.

## Technical map

| Piece | Role |
|--------|------|
| `examples/18-follow-up-agent.ts` | Watcher (`onDirectMessage`), state machine, LLM calls, wiring |
| `examples/lib/followup-store.ts` | SQLite persistence for follow-up rows |
| `Reminders` | Nudge + 24h bump (`llms.txt` — Smart Reminders) |
| `sdk.listChats` / `sdk.getMessages` | Candidate DMs + `participant` handles for `send()` |
| Claude | Parse capture, resolve among chats, generate / regenerate draft |

## LLM touchpoints (narrow)

1. **Parse capture** — `contact_hint`, `topic`, `when_expression`, confidence.  
2. **Resolve contact** — pick among DM candidates or flag “need phone”.  
3. **Generate draft** — casual text to the contact.  
4. **Regenerate** — “try again” only (no fine-grained edit loop in v1).
