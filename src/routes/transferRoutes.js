import { Router } from 'express';
import { validate } from '../middleware/validate.js';
import {
    postTransfer,
    getVerify,
    transferSchema,
} from '../controllers/transferController.js';

const router = Router();

router.post('/transfer', validate(transferSchema, 'body'), postTransfer);
router.get('/verify', getVerify);

export default router;
