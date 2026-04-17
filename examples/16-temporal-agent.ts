// Watches DMs, sends thread history (with per-message timestamps) to Claude, replies in-thread.
// Requires: macOS + Full Disk Access for the terminal, ANTHROPIC_API_KEY in the environment.
// Optional: RECIPIENT=+15551234567 — sends one startup iMessage so you know which thread to use.
// Optional: IMESSAGE_DEBUG=1 — enables SDK debug logs (watch + dispatcher).
// Run: bun run examples/16-temporal-agent.ts
//
// Troubleshooting "no reply":
// - Startup ping is sent after startWatching() so callbacks are live; send() also polls chat.db until the
//   outgoing row appears (not only via the WAL watcher), which avoids false "send timeouts" when the DB is slow.
// - You must see [incoming] in the terminal when you text. If you never do, the WAL watcher is not
//   seeing new rows (grant Full Disk Access to the app running bun: Terminal.app, Cursor, iTerm, etc.).
// - If [incoming] shows chatKind "group", this handler skips it — use a 1:1 iMessage thread.
// - If Messages.app shows your reply on the "green/blue sent" side on the Mac for that thread, the
//   DB may mark it is_from_me; the SDK then drops it before any callback. Text from another number.

import Anthropic from '@anthropic-ai/sdk'
import type { Message } from '../src'
import { IMessageSDK } from '../src'

const sdk = new IMessageSDK({ debug: process.env.IMESSAGE_DEBUG === '1' })
/** Only messages at/after this instant are sent to Claude (not the whole iMessage thread). */
const engineStartedAt = new Date()
const anthropic = new Anthropic()
const model = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-20250514'
const recipient = process.env.RECIPIENT?.trim()
const MAX_SESSION_MESSAGES = 200

const hasAnthropicKey = Boolean(process.env.ANTHROPIC_API_KEY?.trim())
const MISSING_KEY_REPLY =
    'This Mac agent needs ANTHROPIC_API_KEY set in the shell that runs bun. Export it and restart the script.'

const STARTUP_PING_TEXT =
    'Temporal agent is running on the Mac — reply in this thread to talk to it. (You can ignore this if you already know the thread.)'

function buildSystemPrompt(now: Date): string {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    const when = now.toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short', timeZone })

    return `You are a personal memory and context assistant embedded in iMessage. The current date and time is: ${when} (timezone: ${timeZone}).

You only see messages from this agent session (since this process started), not the entire thread before that. Each line is prefixed with when that message was sent or received. Use it to:
- Track deadlines, events, and commitments the user has mentioned over time
- Surface anything time-sensitive relative to today
- Answer questions about things they've told you previously
- Notice when something they logged is coming up or overdue

When the user texts you:
- If they ask what's coming up or pending, summarize what's relevant now based on thread history and today's date
- If they're logging something new ("interview Friday 4pm", "rent due the 1st"), acknowledge and confirm
- If they ask a direct question, answer using thread history as context

Be terse. This is iMessage. No markdown, no dash bullets — plain text, line breaks only when listing.`
}

function formatHistory(messages: Awaited<ReturnType<IMessageSDK['getMessages']>>): string {
    if (messages.length === 0) return '(no previous messages)'

    return messages
        .map((m) => {
            const who = m.isFromMe ? 'Agent' : 'User'
            const when = m.createdAt.toISOString()
            const local = m.createdAt.toLocaleString('en-US', {
                dateStyle: 'short',
                timeStyle: 'short',
            })
            return `[${when} local ${local}] ${who}: ${m.text ?? '(attachment)'}`
        })
        .join('\n')
}

async function respond(
    incomingMsg: Awaited<ReturnType<IMessageSDK['getMessages']>>[number],
): Promise<string> {
    const now = new Date()

    const history = await sdk.getMessages({
        participant: incomingMsg.participant ?? undefined,
        since: engineStartedAt,
        limit: MAX_SESSION_MESSAGES,
    })

    const priorMessages = history.filter((m) => m.rowId !== incomingMsg.rowId)

    const userMessage = `Conversation history:\n\n${formatHistory(priorMessages)}\n\nNew message: ${incomingMsg.text}`

    const response = await anthropic.messages.create({
        model,
        max_tokens: 1000,
        system: buildSystemPrompt(now),
        messages: [{ role: 'user', content: userMessage }],
    })

    const textBlock = response.content.find((b) => b.type === 'text')
    return textBlock?.type === 'text'
        ? textBlock.text.trim()
        : 'Something went wrong. Try again.'
}

async function replyWithMissingKey(msg: Message): Promise<void> {
    try {
        await sdk.message(msg).replyText(MISSING_KEY_REPLY).execute()
    } catch (err) {
        console.error('Failed to send missing-key reply in thread:', err)
    }
}

async function handleUserText(msg: Message): Promise<void> {
    if (!msg.text?.trim()) return

    console.log(`[${new Date().toLocaleTimeString()}] handleUserText: "${msg.text}"`)

    if (!hasAnthropicKey) {
        console.warn('[agent] ANTHROPIC_API_KEY is not set — replying with error text in iMessage.')
        await replyWithMissingKey(msg)
        return
    }

    try {
        const reply = await respond(msg)
        await sdk.message(msg).replyText(reply).execute()
        console.log(`→ ${reply.split('\n')[0]}`)
    } catch (err) {
        console.error('Error:', err)
        await sdk.message(msg).replyText('Something went wrong. Try again.').execute()
    }
}

function isDmLike(msg: Message): boolean {
    return msg.chatKind === 'dm' || msg.chatKind === 'unknown'
}

if (hasAnthropicKey) {
    console.log('ANTHROPIC_API_KEY is set.')
} else {
    console.warn('ANTHROPIC_API_KEY is not set — incoming DMs will get a short error reply in iMessage.')
}

console.log('Temporal context agent running (Ctrl+C to stop)...')
console.log(
    'Watch for [incoming] lines when you send a text. If nothing prints, the watcher is not receiving DB updates for this process.',
)

let checkpointCount = 0

await sdk.startWatching({
    onCheckpoint: (t) => {
        checkpointCount += 1
        if (checkpointCount === 1 || checkpointCount % 20 === 0) {
            console.log(`[watch checkpoint #${checkpointCount}] ${t.toISOString()} — watcher loop is alive`)
        }
    },
    onError: (err) => {
        console.error('[watch / dispatch error]', err)
    },
    onGroupMessage: (msg) => {
        console.log('[onGroupMessage]', {
            rowId: msg.rowId,
            participant: msg.participant,
            textPreview: msg.text?.slice(0, 120) ?? null,
        })
    },
    onMessage: async (msg) => {
        console.log('[incoming]', {
            rowId: msg.rowId,
            chatKind: msg.chatKind,
            participant: msg.participant,
            isFromMe: msg.isFromMe,
            textPreview: msg.text?.slice(0, 120) ?? null,
        })

        if (!msg.text?.trim()) {
            console.log('[incoming] skip: no text (attachment-only or empty)')
            return
        }

        if (msg.chatKind === 'group') {
            console.log('[incoming] skip: group chat (this example only handles 1:1)')
            return
        }

        if (!isDmLike(msg)) {
            console.log('[incoming] skip: chatKind is not dm or unknown:', msg.chatKind)
            return
        }

        await handleUserText(msg)
    },
    onDirectMessage: (msg) => {
        console.log('[onDirectMessage]', {
            rowId: msg.rowId,
            chatKind: msg.chatKind,
            participant: msg.participant,
            isFromMe: msg.isFromMe,
            textPreview: msg.text?.slice(0, 120) ?? null,
        })
    },
})

if (recipient) {
    try {
        const ping = await sdk.send(recipient, STARTUP_PING_TEXT)
        if (!ping.message) {
            console.warn(
                'Startup ping: AppleScript ran but the row was not confirmed in chat.db (check Full Disk Access / Messages).',
            )
        }
        console.log(`Sent startup ping to ${recipient} — reply there to drive the agent.`)
        if (!hasAnthropicKey) {
            await sdk.send(recipient, `Note: ${MISSING_KEY_REPLY}`)
            console.log('Sent missing-key notice to RECIPIENT.')
        }
    } catch (err) {
        console.error('Startup ping failed (check Messages is signed in):', err)
    }
} else {
    console.log('Tip: set RECIPIENT=+15551234567 (your number) to receive a startup iMessage with the right thread.')
}

process.on('SIGINT', async () => {
    sdk.stopWatching()
    await sdk.close()
    process.exit(0)
})
