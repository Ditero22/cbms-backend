import { AppError } from './errors/AppError.js'

const httpMethods = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
  'CONNECT',
  'TRACE',
])

// Log classifications are deliberately allowlisted. Error messages, arbitrary
// names/codes, SQL, parameters, causes and PostgreSQL details may contain private data.
const applicationErrorCodes = new Set([
  'DATABASE_UNAVAILABLE',
  'DATABASE_MIGRATIONS_REQUIRED',
  'MIGRATION_CONFIGURATION_ERROR',
  'PRIVATE_STORAGE_REQUIRED',
  'PROOF_STORAGE_INVALID',
  'PROOF_STORAGE_UNAVAILABLE',
  'EMPLOYEE_CREATE_FAILED',
  'ROLE_CREATE_FAILED',
  'USER_CREATE_FAILED',
  'PAYROLL_ENTRY_FAILED',
  'PAYROLL_CREATE_FAILED',
  'TRANSFER_CREATE_FAILED',
])

export function requestDiagnostics(request: { method?: string; url?: string }) {
  let pathname = '/'
  try {
    pathname = new URL(request.url ?? '/', 'http://cbms.invalid').pathname
  } catch {
    // Invalid URLs must not send their untrusted contents into logs.
  }
  return {
    method: request.method && httpMethods.has(request.method) ? request.method : 'OTHER',
    pathname,
  }
}

export function errorDiagnostics(error: unknown) {
  const applicationError = error instanceof AppError
  return {
    errorType: applicationError ? 'ApplicationError' : 'InternalError',
    errorCode:
      applicationError && applicationErrorCodes.has(error.code) ? error.code : 'INTERNAL_ERROR',
  }
}
