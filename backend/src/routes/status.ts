import { Router } from 'express';
import { getSchedulerStatus } from '../scheduler';
import { memoryReport } from '../monitor/memory';

const router = Router();

router.get('/', (req, res) => {
  res.json(getSchedulerStatus());
});

// Separate path so the schedule list above keeps returning a bare array
router.get('/memory', (req, res) => {
  res.json(memoryReport());
});

export default router;
