/**
 * Local SQLite persistence for the follow-up agent example (examples/18-follow-up-agent.ts).
 * Uses Bun's built-in SQLite driver.
 */

import { Database } from 'bun:sqlite'

export type FollowUpStatus = 'scheduled' | 'nudge_sent' | 'awaiting_send' | 'sent' | 'archived'

export interface FollowUpRow {
    readonly id: string
    readonly user_participant: string
    readonly contact_phone: string
    readonly contact_name: string | null
    readonly topic: string
    readonly scheduled_at: string
    readonly reminder_task_id: string | null
    readonly bump_task_id: string | null
    readonly status: FollowUpStatus
    readonly draft_text: string | null
    readonly created_at: string
}

export class FollowUpStore {
    private readonly db: Database

    constructor(dbPath: string) {
        this.db = new Database(dbPath, { create: true })
        this.db.run(`
            CREATE TABLE IF NOT EXISTS followups (
                id TEXT PRIMARY KEY,
                user_participant TEXT NOT NULL,
                contact_phone TEXT NOT NULL,
                contact_name TEXT,
                topic TEXT NOT NULL,
                scheduled_at TEXT NOT NULL,
                reminder_task_id TEXT,
                bump_task_id TEXT,
                status TEXT NOT NULL,
                draft_text TEXT,
                created_at TEXT NOT NULL
            )
        `)
    }

    insert(row: Omit<FollowUpRow, 'draft_text'> & { draft_text?: string | null }): void {
        this.db.run(
            `INSERT INTO followups (
                id, user_participant, contact_phone, contact_name, topic, scheduled_at,
                reminder_task_id, bump_task_id, status, draft_text, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                row.id,
                row.user_participant,
                row.contact_phone,
                row.contact_name,
                row.topic,
                row.scheduled_at,
                row.reminder_task_id,
                row.bump_task_id,
                row.status,
                row.draft_text ?? null,
                row.created_at,
            ],
        )
    }

    get(id: string): FollowUpRow | null {
        const row = this.db.query('SELECT * FROM followups WHERE id = ?').get(id) as Record<string, unknown> | null
        return row == null ? null : mapRow(row)
    }

    updateDraft(id: string, draft: string | null): void {
        this.db.run('UPDATE followups SET draft_text = ? WHERE id = ?', [draft, id])
    }

    updateStatus(id: string, status: FollowUpStatus): void {
        this.db.run('UPDATE followups SET status = ? WHERE id = ?', [status, id])
    }

    setBumpTaskId(id: string, bumpTaskId: string | null): void {
        this.db.run('UPDATE followups SET bump_task_id = ? WHERE id = ?', [bumpTaskId, id])
    }

    close(): void {
        this.db.close()
    }
}

function mapRow(row: Record<string, unknown>): FollowUpRow {
    return {
        id: String(row.id),
        user_participant: String(row.user_participant),
        contact_phone: String(row.contact_phone),
        contact_name: row.contact_name == null ? null : String(row.contact_name),
        topic: String(row.topic),
        scheduled_at: String(row.scheduled_at),
        reminder_task_id: row.reminder_task_id == null ? null : String(row.reminder_task_id),
        bump_task_id: row.bump_task_id == null ? null : String(row.bump_task_id),
        status: row.status as FollowUpStatus,
        draft_text: row.draft_text == null ? null : String(row.draft_text),
        created_at: String(row.created_at),
    }
}
