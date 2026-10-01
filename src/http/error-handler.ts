import type { ErrorRequestHandler } from 'express'
import { logger } from '@/config/logger.js'
import { AppError } from '@/shared/errors/AppError.js'
import { errorDiagnostics } from '@/shared/diagnostics.js'

export const errorHandler: ErrorRequestHandler = (error: unknown, req, res, next) => {
  void next
  const knownError = error instanceof AppError ? error : null
  const parserStatus =
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'number'
      ? error.status
      : undefined
  const status = knownError?.status ?? (parserStatus && parserStatus < 500 ? parserStatus : 500)

  if (status >= 500)
    logger.error({ ...errorDiagnostics(error), requestId: req.id }, 'Request failed')

  const detail = knownError?.details
  res.status(status).json({
    error: {
      code:
        knownError?.code ??
        (status === 413
          ? 'PAYLOAD_TOO_LARGE'
          : status === 400
            ? 'INVALID_REQUEST'
            : 'INTERNAL_ERROR'),
      message:
        knownError?.message ??
        (status === 413
          ? 'The upload exceeds the 10 MB limit.'
          : status === 400
            ? 'The request body is invalid.'
            : 'An unexpected error occurred.'),
      ...(detail === undefined ? {} : { details: detail }),
    },
    requestId: req.id,
  })
}
