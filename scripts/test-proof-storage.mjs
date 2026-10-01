import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

export function createTestProofStorage() {
  const parent = resolve(tmpdir())
  const directory = resolve(mkdtempSync(join(parent, 'cbms-test-proofs-')))
  return {
    environment: {
      LOCAL_UPLOAD_DIR: directory,
      R2_ACCOUNT_ID: '',
      R2_ACCESS_KEY_ID: '',
      R2_SECRET_ACCESS_KEY: '',
      R2_BUCKET_NAME: '',
      R2_PUBLIC_URL: '',
    },
    cleanup() {
      // Only remove the exact unique directory created by this invocation.
      if (dirname(directory) !== parent || !basename(directory).startsWith('cbms-test-proofs-'))
        throw new Error('Unsafe test proof storage cleanup path.')
      rmSync(directory, { recursive: true, force: true })
    },
  }
}
