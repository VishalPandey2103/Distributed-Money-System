import { z } from 'zod';
import * as ledgerService from '../services/ledgerService.js';
import { parsePaise, bigintReplacer } from '../utils/money.js';
import { accountIdSchema } from './accountController.js';

export const transferSchema = z.object({
    txnId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
    from: accountIdSchema,
    to: accountIdSchema,
    amountPaise: z.union([z.string(), z.number()]),
});

export async function postTransfer(req, res, next) {
    try {
        const { txnId, from, to, amountPaise } = req.valid;
        const amt = parsePaise(amountPaise);
        if (amt <= 0n) {
            return res.status(400).json({
                error: { code: 'NON_POSITIVE_AMOUNT', message: 'amount must be > 0' },
            });
        }

        const result = await ledgerService.transfer({
            txnId,
            fromAccount: from,
            toAccount: to,
            amountPaise: amt,
        });

        const status = result.cached ? 200 : 201;
        res
            .status(status)
            .type('application/json')
            .send(
                JSON.stringify(
                    {
                        cached: result.cached,
                        source: result.source,
                        ...result.body,
                    },
                    bigintReplacer
                )
            );
    } catch (err) {
        next(err);
    }
}

export async function getVerify(_req, res, next) {
    try {
        const result = await ledgerService.verifyLedger();
        res.json(result);
    } catch (err) {
        next(err);
    }
}
