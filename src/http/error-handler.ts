import type { ErrorRequestHandler } from 'express'
import { logger } from '@/config/logger.js'
import { AppError } from '@/shared/errors/AppError.js'
import { errorDiagnostics } from '@/shared/diagnostics.js'

export const errorHandler: ErrorRequestHandler = (error: unknown, req, res, next) => {
  if (res.headersSent) return next(error)
  const knownError = error instanceof AppError ? error : null
  const parserStatus =
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'number'
      ? error.status
      : undefined
  const status =
    knownError?.status ??
    (parserStatus && Number.isInteger(parserStatus) && parserStatus >= 400 && parserStatus < 500
      ? parserStatus
      : 500)

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
            : status === 415
              ? 'UNSUPPORTED_MEDIA_TYPE'
              : 'INTERNAL_ERROR'),
      message:
        knownError?.message ??
        (status === 413
          ? 'The request exceeds the allowed size limit.'
          : status === 400
            ? 'The request body is invalid.'
            : status === 415
              ? 'The request body uses an unsupported encoding or character set.'
              : 'An unexpected error occurred.'),
      ...(detail === undefined ? {} : { details: detail }),
    },
    requestId: req.id,
  })
}
