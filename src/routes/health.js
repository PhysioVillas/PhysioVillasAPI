import { Router } from 'express';
import { getHealth, getReadiness } from '../services/healthService.js';

function createHealthRouter({ database } = {}) {
  const router = Router();

  router.get('/', (_request, response) => {
    response.status(200).json(getHealth());
  });

  router.get('/ready', async (_request, response) => {
    const readiness = await getReadiness({ database });
    response.status(readiness.status === 'ready' ? 200 : 503).json(readiness);
  });

  return router;
}

export { createHealthRouter };
