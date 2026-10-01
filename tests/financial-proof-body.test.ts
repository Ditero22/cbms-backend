import { expect, it } from 'vitest'
import { parseFinancialProofBody } from '@/http/financial-proof-body.js'
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lN8AAAAASUVORK5CYII=',
  'base64',
)
async function request(form: FormData) {
  const wire = new Response(form)
  const contentType = wire.headers.get('content-type')!
  return { body: Buffer.from(await wire.arrayBuffer()), get: () => contentType }
}
function form() {
  const value = new FormData()
  value.set('data', JSON.stringify({ amount: '1.00' }))
  value.set('proofFile', new Blob([png], { type: 'image/png' }), 'proof.png')
  return value
}
it('parses one bounded image and JSON metadata without database or encoded-header storage', async () => {
  const parsed = await parseFinancialProofBody(await request(form()))
  expect(parsed.values).toEqual({ amount: '1.00' })
  expect(parsed.proof).toMatchObject({
    fileName: 'proof.png',
    mimeType: 'image/png',
    bytes: png,
    hash: expect.stringMatching(/^[a-f0-9]{64}$/),
  })
})
it('rejects missing, malformed, duplicate and unexpected multipart fields', async () => {
  const missing = form()
  missing.delete('proofFile')
  const duplicate = form()
  duplicate.append('data', '{}')
  const extra = form()
  extra.append('userId', 'forged')
  const invalidJson = form()
  invalidJson.set('data', '{')
  for (const invalid of [missing, duplicate, extra, invalidJson])
    await expect(parseFinancialProofBody(await request(invalid))).rejects.toMatchObject({
      status: 400,
    })
  await expect(
    parseFinancialProofBody({
      body: Buffer.from('bad boundary'),
      get: () => 'multipart/form-data',
    }),
  ).rejects.toMatchObject({ code: 'INVALID_PAYMENT_FORM' })
})
it('rejects disguised, non-image, empty and oversized proof content', async () => {
  for (const [bytes, type, name] of [
    [Buffer.from('MZ'), 'image/png', 'proof.png'],
    [Buffer.from('%PDF-1.4\n%%EOF'), 'application/pdf', 'proof.pdf'],
    [Buffer.alloc(0), 'image/png', 'proof.png'],
    [Buffer.alloc(10 * 1024 * 1024 + 1), 'image/png', 'proof.png'],
  ] as const) {
    const invalid = form()
    invalid.set('proofFile', new Blob([bytes], { type }), name)
    await expect(parseFinancialProofBody(await request(invalid))).rejects.toMatchObject({
      code: 'INVALID_PROOF_FILE',
    })
  }
})
