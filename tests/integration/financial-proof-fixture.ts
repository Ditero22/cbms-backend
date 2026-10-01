import { randomUUID } from 'node:crypto'
import { philippineDate } from '@/shared/philippine-date.js'
export const paymentProofPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lN8AAAAASUVORK5CYII=',
  'base64',
)
export function paymentProofForm(values: Record<string, unknown>, bytes = paymentProofPng) {
  const form = new FormData()
  form.set(
    'data',
    JSON.stringify({ paymentDate: philippineDate(), requestKey: randomUUID(), ...values }),
  )
  form.set('proofFile', new Blob([bytes], { type: 'image/png' }), 'payment-proof.png')
  return form
}
