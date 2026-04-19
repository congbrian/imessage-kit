// Follow-up agent: natural-language capture → confirm → scheduled nudge → draft → send.
// Spec + limitations: examples/FOLLOWUP-AGENT.md — SDK patterns: llms.txt (root).
//
// Run: bun run examples/18-follow-up-agent.ts
// Requires: macOS, Full Disk Access, Messages signed in, ANTHROPIC_API_KEY.

import Anthropic from '@anthropic-ai/sdk'
import { join } from 'node:path'
import type { Chat, Message } from '../src'
import { IMessageSDK, Reminders, parseAtExpression } from '../src'
import { FollowUpStore, type FollowUpRow } from './lib/followup-store'

const sdk = new IMessageSDK({ debug: process.env.IMESSAGE_DEBUG === '1' })
const dbPath = process.env.FOLLOWUP_DB_PATH?.trim() || join(process.cwd(), '.followup-agent.sqlite')
const store = new FollowUpStore(dbPath)

const anthropic = new Anthropic()
const model = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-20250514'
const recipient = process.env.RECIPIENT?.trim()
const hasKey = Boolean(process.env.ANTHROPIC_API_KEY?.trim())

const STARTUP_PING =
    'Follow-up agent is running — text me a reminder like: remind me to follow up with Sarah about the invoice tomorrow 9am'

type Mode = 'idle' | 'confirming' | 'after_nudge' | 'draft_ready'

interface PendingConfirm {
    readonly contact_phone: string
    readonly contact_name: string | null
    readonly topic: string
    readonly when_expression: string
    readonly scheduled_at: Date
}

interface UserState {
    mode: Mode
    activeFollowUpId?: string
    pending?: PendingConfirm
    draftText?: string
}

const states = new Map<string, UserState>()

function stateFor(participant: string): UserState {
    let s = states.get(participant)
    if (s == null) {
        s = { mode: 'idle' }
        states.set(participant, s)
    }
    return s
}

function extractJsonObject(text: string): unknown {
    const trimmed = text.trim()
    const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i)
    const body = fence?.[1] != null ? fence[1].trim() : trimmed
    const start = body.indexOf('{')
    const end = body.lastIndexOf('}')
    if (start === -1 || end <= start) {
        throw new Error('No JSON object in model response')
    }
    return JSON.parse(body.slice(start, end + 1)) as unknown
}

async function claudeText(system: string, user: string): Promise<string> {
    const res = await anthropic.messages.create({
        model,
        max_tokens: 1_500,
        system: system,
        messages: [{ role: 'user', content: user }],
    })
    const block = res.content.find((b) => b.type === 'text')
    if (block?.type !== 'text') {
        throw new Error('No text from Claude')
    }
    return block.text.trim()
}

function normalizeWhenExpression(raw: string): string {
    let s = raw.toLowerCase().trim()
    s = s.replace(/\bthursday\s+morning\b/g, 'thursday 9am')
    s = s.replace(/\bfriday\s+morning\b/g, 'friday 9am')
    s = s.replace(/\bmonday\s+morning\b/g, 'monday 9am')
    s = s.replace(/\btuesday\s+morning\b/g, 'tuesday 9am')
    s = s.replace(/\bwednesday\s+morning\b/g, 'wednesday 9am')
    s = s.replace(/\bsaturday\s+morning\b/g, 'saturday 9am')
    s = s.replace(/\bsunday\s+morning\b/g, 'sunday 9am')
    s = s.replace(/\bmorning\b/g, '9am')
    s = s.replace(/\bafternoon\b/g, '2pm')
    s = s.replace(/\bevening\b/g, '6pm')
    s = s.replace(/\bnoon\b/g, '12pm')
    return s.trim()
}

interface ParsedCapture {
    contact_hint: string
    topic: string
    when_expression: string
    confidence: 'high' | 'medium' | 'low'
    clarification_needed: string | null
}

async function parseCapture(userText: string): Promise<ParsedCapture> {
    const system = `You extract follow-up reminders from the user's message. Respond with ONLY a JSON object (no markdown), keys:
- contact_hint: string — name, nickname, or phone/email fragment they want to follow up WITH (not the user themselves).
- topic: string — what the follow-up is about, short.
- when_expression: string — MUST be parseable like "thursday 9am", "tomorrow 8am", "friday 2pm", "5pm" (see examples). Prefer weekday + time.
- confidence: "high" | "medium" | "low"
- clarification_needed: string or null — if confidence is not high, a single short question for the user.

Never invent a phone number in this JSON.`

    const raw = await claudeText(system, `User message:\n${userText}`)
    const j = extractJsonObject(raw) as Record<string, unknown>
    return {
        contact_hint: String(j.contact_hint ?? '').trim(),
        topic: String(j.topic ?? '').trim(),
        when_expression: String(j.when_expression ?? '').trim(),
        confidence: (j.confidence === 'medium' || j.confidence === 'low' ? j.confidence : 'high') as ParsedCapture['confidence'],
        clarification_needed: j.clarification_needed == null ? null : String(j.clarification_needed),
    }
}

interface DmCandidate {
    readonly index: number
    readonly display: string
    readonly address: string
}

async function loadDmCandidates(contactHint: string): Promise<readonly DmCandidate[]> {
    const token = contactHint.split(/\s+/)[0] ?? contactHint
    const chats = await sdk.listChats({
        kind: 'dm',
        search: token.length >= 2 ? token : contactHint,
        sortBy: 'recent',
        limit: 12,
    })

    const out: DmCandidate[] = []
    let i = 0
    for (const c of chats) {
        const addr = await resolveAddressForChat(c)
        if (addr == null) continue
        out.push({
            index: i,
            display: c.name ?? addr,
            address: addr,
        })
        i += 1
    }
    return out
}

async function resolveAddressForChat(chat: Chat): Promise<string | null> {
    const msgs = await sdk.getMessages({ chatId: chat.chatId, limit: 12 })
    const incoming = msgs.find((m) => !m.isFromMe && m.participant)
    if (incoming?.participant) return incoming.participant
    const any = msgs.find((m) => m.participant)
    return any?.participant ?? null
}

async function resolveContact(contactHint: string, candidates: readonly DmCandidate[]): Promise<{ phone: string; name: string | null } | null> {
    if (candidates.length === 0) return null
    if (candidates.length === 1) {
        const only = candidates[0]
        if (only == null) return null
        return { phone: only.address, name: only.display }
    }

    const lines = candidates.map((c) => `${c.index}: ${c.display} → ${c.address}`).join('\n')
    const system = `You pick which DM row matches the user's contact hint. Respond ONLY JSON: {"choice_index": number} using the index from the list, or {"need_phone": true} if none clearly match.`

    const raw = await claudeText(system, `contact_hint: ${contactHint}\nCandidates:\n${lines}`)
    const j = extractJsonObject(raw) as Record<string, unknown>
    if (j.need_phone === true) return null
    const idx = Number(j.choice_index)
    if (!Number.isInteger(idx) || idx < 0 || idx >= candidates.length) return null
    const picked = candidates[idx]
    return picked == null ? null : { phone: picked.address, name: picked.display }
}

async function generateDraft(contactName: string, topic: string): Promise<string> {
    const system = `You write a short, casual iMessage the user can send to someone they know. No markdown, no bullet lists. One or two sentences max unless they asked for detail. Warm and direct.`

    const raw = await claudeText(
        system,
        `Write a message to ${contactName} about: ${topic}. They are following up after a previous conversation.`,
    )
    return raw.replace(/^["']|["']$/g, '').trim()
}

function mightBeFollowUpRequest(text: string): boolean {
    const s = text.toLowerCase()
    return /remind\s+me/.test(s) || /follow\s*-?\s*up/.test(s) || /nudge\s+me/.test(s) || /ping\s+me\s+to/.test(s)
}

function isYes(t: string): boolean {
    const s = t.toLowerCase().trim()
    return s === 'y' || s === 'yes' || s === 'yeah' || s === 'yep' || s === 'sure' || s === 'ok' || s === 'okay' || s === 'confirm' || s === 'sounds good'
}

function isNo(t: string): boolean {
    const s = t.toLowerCase().trim()
    return s === 'n' || s === 'no' || s === 'nope' || s === 'cancel' || s === 'skip'
}

function isSend(t: string): boolean {
    const s = t.toLowerCase().trim()
    return s === 'send' || s === 'send it' || s === 'go' || s === 'ship it'
}

function isTryAgain(t: string): boolean {
    const s = t.toLowerCase()
    return /\btry again\b/.test(s) || /\bregenerate\b/.test(s) || /^again$/i.test(s.trim())
}

function bumpTaskId(mainId: string): string {
    return `${mainId}:bump`
}

function baseFollowUpId(taskId: string): string {
    return taskId.endsWith(':bump') ? taskId.slice(0, -':bump'.length) : taskId
}

const reminders = new Reminders(sdk, {
    onSent: (task) => {
        void onReminderSent(task.id)
    },
    onError: (task, err) => {
        console.error('[reminder error]', task.id, err.message)
    },
})

async function onReminderSent(taskId: string): Promise<void> {
    const baseId = baseFollowUpId(taskId)
    const row = store.get(baseId)
    if (row == null) return

    if (taskId.endsWith(':bump')) {
        if (row.status === 'sent' || row.status === 'archived') return
        store.updateStatus(baseId, 'archived')
        const u = row.user_participant
        const st = stateFor(u)
        if (st.activeFollowUpId === baseId) {
            st.mode = 'idle'
            st.activeFollowUpId = undefined
            st.draftText = undefined
        }
        try {
            await sdk.send(u, 'Archiving that follow-up nudge — ping me anytime with a new reminder.')
        } catch {
            /* ignore */
        }
        return
    }

    store.updateStatus(baseId, 'nudge_sent')
    const st = stateFor(row.user_participant)
    st.mode = 'after_nudge'
    st.activeFollowUpId = baseId
    st.draftText = undefined
}

async function handleIdleCapture(msg: Message, participant: string, text: string): Promise<void> {
    if (!mightBeFollowUpRequest(text)) {
        await sdk
            .message(msg)
            .replyText(
                'Tell me what to track, e.g.:\nremind me to follow up with Alex about the contract friday 2pm\n\nI only handle follow-up reminders in this thread.',
            )
            .execute()
        return
    }

    let parsed: ParsedCapture
    try {
        parsed = await parseCapture(text)
    } catch (e) {
        console.error(e)
        await sdk.message(msg).replyText('I could not parse that. Try again with who, what, and when (e.g. thursday 9am).').execute()
        return
    }

    if (parsed.confidence !== 'high' && parsed.clarification_needed) {
        await sdk.message(msg).replyText(parsed.clarification_needed).execute()
        return
    }

    if (!parsed.contact_hint || !parsed.topic) {
        await sdk.message(msg).replyText('I need a person and a topic. Example: remind me to follow up with Sam about the invoice tomorrow 9am.').execute()
        return
    }

    const whenNorm = normalizeWhenExpression(parsed.when_expression)
    let scheduledAt: Date
    try {
        scheduledAt = parseAtExpression(whenNorm)
    } catch {
        await sdk
            .message(msg)
            .replyText(
                `I could not understand the time "${parsed.when_expression}". Use something like thursday 9am or tomorrow 2pm (see project llms.txt).`,
            )
            .execute()
        return
    }

    if (scheduledAt.getTime() <= Date.now() + 30_000) {
        await sdk.message(msg).replyText('That time is too soon or in the past — pick a slightly later time.').execute()
        return
    }

    const candidates = await loadDmCandidates(parsed.contact_hint)
    const resolved = await resolveContact(parsed.contact_hint, candidates)

    if (resolved == null) {
        await sdk
            .message(msg)
            .replyText(
                `I could not match "${parsed.contact_hint}" to a recent DM. Text me their iMessage phone (+15551234567) or email address and I'll use the next message as the contact.`,
            )
            .execute()
        return
    }

    const label = resolved.name ?? resolved.phone
    const whenLocal = scheduledAt.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    const st = stateFor(participant)
    st.mode = 'confirming'
    st.pending = {
        contact_phone: resolved.phone,
        contact_name: resolved.name,
        topic: parsed.topic,
        when_expression: whenNorm,
        scheduled_at: scheduledAt,
    }

    await sdk
        .message(msg)
        .replyText(
            `Got it — I'll nudge you ${whenLocal} to follow up with ${label} (${resolved.phone}) about: ${parsed.topic}\n\nReply yes to schedule or no to cancel.`,
        )
        .execute()
}

async function handleConfirming(msg: Message, participant: string, text: string, st: UserState): Promise<void> {
    const pending = st.pending
    if (pending == null) {
        st.mode = 'idle'
        return
    }

    if (isNo(text)) {
        st.mode = 'idle'
        st.pending = undefined
        await sdk.message(msg).replyText('Cancelled — send another reminder anytime.').execute()
        return
    }

    if (!isYes(text)) {
        await sdk.message(msg).replyText('Reply yes to schedule or no to cancel.').execute()
        return
    }

    const id = crypto.randomUUID()
    const contactLabel = pending.contact_name ?? pending.contact_phone
    const nudgeBody = `Follow-up: touch base with ${contactLabel} about "${pending.topic}". Reply yes if you want a draft to send them.`

    const bumpId = bumpTaskId(id)
    try {
        reminders.exact(pending.scheduled_at, participant, nudgeBody, { id })
        const bumpAt = new Date(pending.scheduled_at.getTime() + 86_400_000)
        reminders.exact(
            bumpAt,
            participant,
            `Still want to follow up with ${contactLabel} about "${pending.topic}"? Reply yes for a draft or no to dismiss.`,
            { id: bumpId },
        )
    } catch (e) {
        console.error(e)
        st.mode = 'idle'
        st.pending = undefined
        await sdk.message(msg).replyText('Could not schedule that time — try a clearer time like friday 2pm.').execute()
        return
    }

    store.insert({
        id,
        user_participant: participant,
        contact_phone: pending.contact_phone,
        contact_name: pending.contact_name,
        topic: pending.topic,
        scheduled_at: pending.scheduled_at.toISOString(),
        reminder_task_id: id,
        bump_task_id: bumpId,
        status: 'scheduled',
        draft_text: null,
        created_at: new Date().toISOString(),
    })

    st.mode = 'idle'
    st.pending = undefined
    await sdk.message(msg).replyText('Done — I will nudge you then.').execute()
}

async function handleAfterNudge(msg: Message, participant: string, text: string, st: UserState): Promise<void> {
    const id = st.activeFollowUpId
    if (id == null) {
        st.mode = 'idle'
        return
    }

    const row = store.get(id)
    if (row == null || row.user_participant !== participant) {
        st.mode = 'idle'
        st.activeFollowUpId = undefined
        return
    }

    if (isNo(text)) {
        if (row.bump_task_id) reminders.cancel(row.bump_task_id)
        store.updateStatus(id, 'archived')
        st.mode = 'idle'
        st.activeFollowUpId = undefined
        await sdk.message(msg).replyText('Okay — archived that follow-up.').execute()
        return
    }

    if (!isYes(text)) {
        await sdk.message(msg).replyText('Reply yes for a draft message, or no to dismiss.').execute()
        return
    }

    let draft: string
    try {
        draft = await generateDraft(row.contact_name ?? row.contact_phone, row.topic)
    } catch (e) {
        console.error(e)
        await sdk.message(msg).replyText('Could not generate a draft — try again in a moment.').execute()
        return
    }

    store.updateDraft(id, draft)
    st.mode = 'draft_ready'
    st.draftText = draft
    await sdk
        .message(msg)
        .replyText(`${draft}\n\nSay send to deliver, skip to cancel, or try again for a new draft.`)
        .execute()
}

async function handleDraftReady(msg: Message, participant: string, text: string, st: UserState): Promise<void> {
    const id = st.activeFollowUpId
    if (id == null) {
        st.mode = 'idle'
        return
    }

    const row = store.get(id) as FollowUpRow
    if (row == null || row.user_participant !== participant) {
        st.mode = 'idle'
        st.activeFollowUpId = undefined
        st.draftText = undefined
        return
    }

    if (isTryAgain(text)) {
        let draft: string
        try {
            draft = await generateDraft(row.contact_name ?? row.contact_phone, row.topic)
        } catch (e) {
            console.error(e)
            await sdk.message(msg).replyText('Could not regenerate — try again in a bit.').execute()
            return
        }
        store.updateDraft(id, draft)
        st.draftText = draft
        await sdk
            .message(msg)
            .replyText(`${draft}\n\nSay send, skip, or try again.`)
            .execute()
        return
    }

    if (isNo(text) || text.toLowerCase().trim() === 'skip') {
        if (row.bump_task_id) reminders.cancel(row.bump_task_id)
        store.updateStatus(id, 'archived')
        st.mode = 'idle'
        st.activeFollowUpId = undefined
        st.draftText = undefined
        await sdk.message(msg).replyText('Skipped — I did not send anything.').execute()
        return
    }

    if (!isSend(text)) {
        await sdk.message(msg).replyText('Say send to deliver, skip to cancel, or try again for a new draft.').execute()
        return
    }

    const body = st.draftText ?? row.draft_text ?? ''
    if (!body.trim()) {
        await sdk.message(msg).replyText('No draft text — say try again.').execute()
        return
    }

    try {
        await sdk.send(row.contact_phone, body)
    } catch (e) {
        console.error(e)
        await sdk.message(msg).replyText('Send failed — check the contact address and try again.').execute()
        return
    }

    if (row.bump_task_id) reminders.cancel(row.bump_task_id)
    store.updateStatus(id, 'sent')
    store.updateDraft(id, body)
    st.mode = 'idle'
    st.activeFollowUpId = undefined
    st.draftText = undefined
    await sdk.message(msg).replyText('Sent. Good luck.').execute()
}

async function onDirectMessage(msg: Message): Promise<void> {
    if (msg.isFromMe) return
    const text = msg.text?.trim()
    if (!text) return

    const participant = msg.participant
    if (participant == null || participant === '') {
        console.warn('[follow-up] missing participant on DM')
        return
    }

    if (!hasKey) {
        await sdk.message(msg).replyText('Set ANTHROPIC_API_KEY in the shell running this agent.').execute()
        return
    }

    const st = stateFor(participant)

    try {
        if (st.mode === 'confirming') {
            await handleConfirming(msg, participant, text, st)
            return
        }
        if (st.mode === 'after_nudge') {
            await handleAfterNudge(msg, participant, text, st)
            return
        }
        if (st.mode === 'draft_ready') {
            await handleDraftReady(msg, participant, text, st)
            return
        }
        await handleIdleCapture(msg, participant, text)
    } catch (e) {
        console.error('[follow-up]', e)
        try {
            await sdk.message(msg).replyText('Something went wrong — try again in a moment.').execute()
        } catch {
            /* ignore */
        }
    }
}

if (hasKey) {
    console.log('ANTHROPIC_API_KEY is set.')
} else {
    console.warn('ANTHROPIC_API_KEY is not set — replies will be errors only.')
}

console.log(`Follow-up agent — DB: ${dbPath}`)
console.log('Watching DMs (onDirectMessage). Ctrl+C to stop.')

await sdk.startWatching({
    onError: (err) => console.error('[watch]', err),
    onDirectMessage: (msg) => {
        void onDirectMessage(msg)
    },
})

if (recipient) {
    try {
        await sdk.send(recipient, STARTUP_PING)
        console.log(`Startup ping sent to ${recipient}`)
    } catch (e) {
        console.error('Startup ping failed:', e)
    }
} else {
    console.log('Tip: set RECIPIENT=+1555… to your handle for a startup ping.')
}

process.on('SIGINT', async () => {
    sdk.stopWatching()
    reminders.destroy()
    store.close()
    await sdk.close()
    process.exit(0)
})
