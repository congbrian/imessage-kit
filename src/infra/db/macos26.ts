/**
 * macOS 26 (Tahoe) query builder.
 *
 * Implements the MessagesDbQueries contract with macOS 26-specific
 * column selections, including ck_chat_id.
 */

import { CHAT_STYLE_DM, CHAT_STYLE_GROUP } from '../../domain/chat'
import { toMacTimestampNs } from '../../domain/timestamp'
import {
    buildChatIdMatchSql,
    type ChatQueryInput,
    type MessageQueryInput,
    type MessagesDbQueries,
    type QueryParam,
} from './contract'

// -----------------------------------------------
// Field selections
// -----------------------------------------------

/**
 * `message.*` is expanded by SQLite against the real `message` table, so new/removed
 * Apple columns do not break the SELECT. `message.ROWID AS id` stays explicit (not in `*`).
 * Join-derived columns are listed after `message.*` so they win on name collisions.
 */
const MESSAGE_SELECT_FIELDS = [
    'message.ROWID AS id',
    'message.*',
    'handle.id AS participant',
    'other_handle.id AS affected_participant',
    'chat.chat_identifier AS chat_id',
    'chat.guid AS chat_guid',
    'chat.service_name AS chat_service',
] as const

const CHAT_FIELDS = [
    'chat.guid',
    'chat.chat_identifier',
    'chat.service_name',
    'chat.style',
    'chat.account_login',
    'chat.is_archived',
    'chat.is_filtered',
    'chat.is_blackholed',
    'chat.is_deleting_incoming_messages',
    'chat.last_read_message_timestamp',
    'chat.display_name',
    'chat_stats.last_date',
    'COALESCE(chat_stats.unread_count, 0) AS unread_count',
] as const

// -----------------------------------------------
// Query builder
// -----------------------------------------------

function escapeLikePattern(input: string): string {
    return input.replace(/[%_\\]/g, (ch) => `\\${ch}`)
}

/** Builds SQL for the current Messages schema (SQLite expands `message.*` / `attachment.*` at runtime). */
export function createMacos26Queries(): MessagesDbQueries {
    return {
        schemaId: 'macos26',

        buildMessageQuery(filter: MessageQueryInput) {
            const conditions: string[] = []
            const params: QueryParam[] = []

            if (filter.unreadOnly) {
                conditions.push('message.is_read = 0')
            }

            if (filter.isFromMe === true) {
                conditions.push('message.is_from_me = 1')
            } else if (filter.isFromMe === false) {
                conditions.push('message.is_from_me = 0')
            }

            if (filter.participant) {
                conditions.push('handle.id = ?')
                params.push(filter.participant)
            }

            if (filter.chatId) {
                const match = buildChatIdMatchSql(filter.chatId, {
                    identifier: 'chat.chat_identifier',
                    guid: 'chat.guid',
                })
                conditions.push(match.sql)
                params.push(...match.params)
            }

            if (filter.service) {
                conditions.push('message.service = ?')
                params.push(filter.service)
            }

            if (filter.hasAttachments) {
                conditions.push(
                    'EXISTS (SELECT 1 FROM message_attachment_join WHERE message_attachment_join.message_id = message.ROWID)'
                )
            }

            if (filter.excludeReactions) {
                conditions.push('(message.associated_message_type IS NULL OR message.associated_message_type = 0)')
            }

            if (filter.sinceRowId != null) {
                conditions.push('message.ROWID > ?')
                params.push(filter.sinceRowId)
            }

            if (filter.since) {
                conditions.push('message.date >= ?')
                params.push(toMacTimestampNs(filter.since))
            }

            if (filter.before) {
                conditions.push('message.date < ?')
                params.push(toMacTimestampNs(filter.before))
            }

            if (filter.search) {
                const escaped = escapeLikePattern(filter.search)
                conditions.push("message.text LIKE ? ESCAPE '\\'")
                params.push(`%${escaped}%`)
            }

            const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

            const hasLimit = filter.limit != null && filter.limit > 0
            const hasOffset = filter.offset != null && filter.offset > 0

            let limitClause = ''

            if (hasLimit) {
                limitClause = 'LIMIT ?'
                params.push(filter.limit as number)
            } else if (hasOffset) {
                limitClause = 'LIMIT -1'
            }

            const offsetClause = hasOffset ? 'OFFSET ?' : ''

            if (hasOffset) {
                params.push(filter.offset as number)
            }

            const orderBy = filter.orderByRowIdAsc ? 'ORDER BY message.ROWID ASC' : 'ORDER BY message.date DESC'

            return {
                sql: `
                SELECT
                    ${MESSAGE_SELECT_FIELDS.join(',\n                    ')}
                FROM message
                LEFT JOIN handle ON message.handle_id = handle.ROWID
                LEFT JOIN handle AS other_handle ON message.other_handle = other_handle.ROWID
                LEFT JOIN chat ON chat.ROWID = (
                    SELECT MIN(chat_message_join.chat_id)
                    FROM chat_message_join
                    WHERE chat_message_join.message_id = message.ROWID
                )
                ${where}
                ${orderBy}
                ${limitClause}
                ${offsetClause}
            `,
                params,
            }
        },

        buildChatQuery(query: ChatQueryInput) {
            const conditions: string[] = []
            const params: QueryParam[] = []

            if (query.chatId) {
                const match = buildChatIdMatchSql(query.chatId, {
                    identifier: 'chat_identifier',
                    guid: 'guid',
                })
                conditions.push(match.sql)
                params.push(...match.params)
            }

            if (query.kind === 'group') {
                conditions.push('style = ?')
                params.push(CHAT_STYLE_GROUP)
            } else if (query.kind === 'dm') {
                conditions.push('style = ?')
                params.push(CHAT_STYLE_DM)
            }

            if (query.service) {
                conditions.push('service_name = ?')
                params.push(query.service)
            }

            if (query.isArchived === true) {
                conditions.push('is_archived = 1')
            } else if (query.isArchived === false) {
                conditions.push('is_archived = 0')
            }

            if (query.hasUnread) {
                conditions.push('unread_count > 0')
            }

            if (query.search) {
                const escaped = escapeLikePattern(query.search)
                conditions.push("(display_name LIKE ? ESCAPE '\\' OR chat_identifier LIKE ? ESCAPE '\\')")
                params.push(`%${escaped}%`, `%${escaped}%`)
            }

            const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

            let orderBy = ''

            if (query.sortBy === 'recent') {
                orderBy = 'ORDER BY (last_date IS NULL), last_date DESC'
            } else if (query.sortBy === 'name') {
                orderBy = 'ORDER BY (display_name IS NULL), display_name ASC'
            }

            let limitClause = ''

            if (query.limit != null && query.limit > 0) {
                limitClause = 'LIMIT ?'
                params.push(query.limit)
            }

            return {
                sql: `
                WITH chat_stats AS (
                    SELECT
                        chat_message_join.chat_id,
                        MAX(message.date) AS last_date,
                        SUM(
                            CASE
                                WHEN message.is_read = 0 AND message.is_from_me = 0 THEN 1
                                ELSE 0
                            END
                        ) AS unread_count
                    FROM chat_message_join
                    INNER JOIN message ON message.ROWID = chat_message_join.message_id
                    GROUP BY chat_message_join.chat_id
                ),
                enriched AS (
                    SELECT
                        ${CHAT_FIELDS.join(',\n                        ')}
                    FROM chat
                    LEFT JOIN chat_stats ON chat_stats.chat_id = chat.ROWID
                )
                SELECT *
                FROM enriched
                ${where}
                ${orderBy}
                ${limitClause}
            `,
                params,
            }
        },

        buildAttachmentQuery(messageIds: readonly number[]) {
            const placeholders = messageIds.map(() => '?').join(',')

            return {
                sql: `
                SELECT
                    message_attachment_join.message_id AS msg_id,
                    attachment.*
                FROM attachment
                INNER JOIN message_attachment_join ON attachment.ROWID = message_attachment_join.attachment_id
                WHERE message_attachment_join.message_id IN (
                    ${placeholders}
                )
                AND (attachment.hide_attachment IS NULL OR attachment.hide_attachment = 0)
                ORDER BY message_attachment_join.message_id ASC, message_attachment_join.attachment_id ASC
            `,
                params: messageIds,
            }
        },
    }
}

/** Default query bundle (same as {@link createMacos26Queries}). */
export const macos26Queries: MessagesDbQueries = createMacos26Queries()
