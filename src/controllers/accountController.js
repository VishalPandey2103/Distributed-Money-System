import { z } from 'zod';
import * as ledgerService from '../services/ledgerService.js';
import { parsePaise, bigintReplacer } from '../utils/money.js';

// Account IDs: no pipe (used as hash delimiter), keep alnum + _/- .
export const accountIdSchema = z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/, 'accountId must be alnum, "_" or "-"');

export const createAccountSchema = z.object({
    accountId: accountIdSchema,
    openingBalancePaise: z.union([z.string(), z.number()]),
});

export const accountParamSchema = z.object({
    accountId: accountIdSchema,
});

export async function createAccount(req, res, next) {
    try {
        const { accountId, openingBalancePaise } = req.valid;
        const balance = parsePaise(openingBalancePaise);
        if (balance < 0n) {
            return res.status(400).json({
                error: { code: 'NEGATIVE_OPENING_BALANCE', message: 'opening balance must be >= 0' },
            });
        }
        const result = await ledgerService.createAccount({
            accountId,
            openingBalancePaise: balance,
        });
        res
            .status(201)
            .type('application/json')
            .send(JSON.stringify(result, bigintReplacer));
    } catch (err) {
        next(err);
    }
}

export async function getAccount(req, res, next) {
    try {
        const { accountId } = req.valid;
        const result = await ledgerService.getAccount(accountId);
        res.type('application/json').send(JSON.stringify(result, bigintReplacer));
    } catch (err) {
        next(err);
    }
}
