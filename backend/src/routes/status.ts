import { Router } from 'express';
import { getSchedulerStatus } from '../scheduler';

const router = Router();

router.get('/', (req, res) => {
  res.json(getSchedulerStatus());
});

export default router;
