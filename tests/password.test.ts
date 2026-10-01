import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from '@/shared/security/password.js'

describe('password hashing', () => {
  it('verifies the password without storing it as plain text', async () => {
    const password = 'CBMS test password 2026!'
    const hash = await hashPassword(password)

    expect(hash).not.toContain(password)
    expect(await verifyPassword(password, hash)).toBe(true)
    expect(await verifyPassword('wrong password', hash)).toBe(false)
  })

  it('rejects malformed stored hashes', async () => {
    await expect(verifyPassword('any password', 'not-a-hash')).resolves.toBe(false)
  })
})
