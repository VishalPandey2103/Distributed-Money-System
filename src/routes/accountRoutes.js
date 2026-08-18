import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import {
    createAccount,
    getAccount,
    createAccountSchema,
    accountParamSchema,
} from '../controllers/accountController.js';

const router = Router();

router.post('/accounts', validate(createAccountSchema, 'body'), createAccount);
router.get('/accounts/:accountId', validate(accountParamSchema, 'params'), getAccount);

export default router;
