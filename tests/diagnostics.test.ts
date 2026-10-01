import { describe, expect, it } from 'vitest'
import { AppError } from '@/shared/errors/AppError.js'
import { errorDiagnostics, requestDiagnostics } from '@/shared/diagnostics.js'

describe('safe request diagnostics', () => {
  it('retains method and pathname without query or fragment values', () => {
    expect(
      requestDiagnostics({
        method: 'GET',
        url: '/api/v1/customers?search=synthetic-private-person#synthetic-private-fragment',
      }),
    ).toEqual({ method: 'GET', pathname: '/api/v1/customers' })
  })

  it('omits absolute URL credentials and origin', () => {
    expect(
      requestDiagnostics({
        method: 'POST',
        url: 'https://synthetic-private-user:synthetic-private-password@example.invalid/api/ready?token=synthetic-private-token',
      }),
    ).toEqual({ method: 'POST', pathname: '/api/ready' })
  })

  it('uses safe fallback metadata for invalid URL and unsupported method', () => {
    expect(requestDiagnostics({ method: 'synthetic-private-method', url: 'https://[' })).toEqual({
      method: 'OTHER',
      pathname: '/',
    })
  })
})

describe('safe error diagnostics', () => {
  it('keeps only an allowlisted application error classification', () => {
    const error = new AppError(503, 'DATABASE_UNAVAILABLE', 'synthetic-private-message', {
      detail: 'synthetic-private-detail',
    })

    expect(errorDiagnostics(error)).toEqual({
      errorType: 'ApplicationError',
      errorCode: 'DATABASE_UNAVAILABLE',
    })
  })

  it('omits nested PostgreSQL and query details from unexpected errors', () => {
    const error = new Error('Failed query: synthetic-private-query', {
      cause: Object.assign(new Error('synthetic-private-database-message'), {
        code: '23505',
        detail: 'Key (email)=(synthetic-private-person@example.invalid) already exists.',
        parameters: ['synthetic-private-parameter'],
      }),
    })
    error.name = 'synthetic-private-error-type'

    expect(errorDiagnostics(error)).toEqual({
      errorType: 'InternalError',
      errorCode: 'INTERNAL_ERROR',
    })
  })

  it('does not log unknown application codes or arbitrary thrown values', () => {
    expect(errorDiagnostics(new AppError(500, 'SYNTHETIC_PRIVATE_CODE', 'private'))).toEqual({
      errorType: 'ApplicationError',
      errorCode: 'INTERNAL_ERROR',
    })
    expect(errorDiagnostics({ code: 'synthetic-private-code', detail: 'private' })).toEqual({
      errorType: 'InternalError',
      errorCode: 'INTERNAL_ERROR',
    })
  })
})
