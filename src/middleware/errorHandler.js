import { AppError, NotLeaderError } from '../services/ledgerService.js';

export function errorHandler(err, req, res, _next) {
    if (err && err.name === 'ZodError' && typeof err.flatten === 'function') {
        return res.status(400).json({
            error: {
                code: 'VALIDATION_ERROR',
                message: 'Request validation failed',
                issues: err.flatten(),
            },
        });
    }

    if (err instanceof NotLeaderError) {
        // 421 Misdirected Request — carries the leader address in
        // both the JSON body and a custom header so proxies can log it.
        if (err.leaderHttp) res.setHeader('X-Leader-Address', err.leaderHttp);
        return res.status(421).json({
            error: {
                code: 'NOT_LEADER',
                message: 'This node is not the current Raft leader',
                leaderId: err.leaderId,
                leaderHttp: err.leaderHttp,
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

    req.log?.error({ err }, 'unhandled error');
    return res.status(500).json({
        error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
}
