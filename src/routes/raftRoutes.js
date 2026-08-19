import { Router } from 'express';
import { getStatus } from '../controllers/raftController.js';

const router = Router();
router.get('/raft/status', getStatus);
export default router;
