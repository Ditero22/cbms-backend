import { withTransaction } from '@/database/transaction.js'

// Rotation and reuse revocation commit atomically. Return a result instead of
// throwing inside the transaction so a detected replay cannot roll back revocation.
export async function rotateRefreshCredential(previousHash: string, nextHash: string) {
  return withTransaction(async (client) => {
    const existing = await client.query<{ id: string }>(
      `select s.id from user_sessions s join users u on u.id = s.user_id
       where s.token_hash = $1 and s.expires_at > now()
         and u.status = 'Active' and u.deleted_at is null for update of s`,
      [previousHash],
    )
    const session = existing.rows[0]
    if (session) {
      await client.query('insert into used_refresh_tokens(token_hash, session_id) values($1,$2)', [
        previousHash,
        session.id,
      ])
      await client.query(
        'update user_sessions set token_hash = $2, last_seen_at = now() where id = $1',
        [session.id, nextHash],
      )
      return { kind: 'rotated' as const, sessionId: session.id }
    }
    const used = await client.query<{ session_id: string; recent: boolean }>(
      "select session_id, used_at > now() - interval '5 seconds' as recent from used_refresh_tokens where token_hash = $1",
      [previousHash],
    )
    if (used.rows[0]?.recent) return { kind: 'concurrent' as const }
    if (used.rows[0])
      await client.query('delete from user_sessions where id = $1', [used.rows[0].session_id])
    return { kind: 'invalid' as const }
  })
}
