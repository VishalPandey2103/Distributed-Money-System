import { AppError } from '../services/ledgerService.js';

// Express recognizes 4-arg middleware as an error handler. Register last.
export function errorHandler(err, req, res, _next) {
    // Zod errors: detect structurally to avoid importing zod here.
    if (err && err.name === 'ZodError' && typeof err.flatten === 'function') {
        return res.status(400).json({
            error: {
                code: 'VALIDATION_ERROR',
                message: 'Request validation failed',
                issues: err.flatten(),
            },
        });
    }

    if (err instanceof AppError) {
        return res.status(err.statusCode).json({
            error: {
                code: err.code,
                message: err.message,
                ...(err.details ? { details: err.details } : {}),
            },
        });
    }

    // Unknown pg errors and everything else.
    req.log?.error({ err }, 'unhandled error');
    return res.status(500).json({
        error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
}
