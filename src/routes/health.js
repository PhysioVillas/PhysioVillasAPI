import { Router } from 'express';
import { getHealth } from '../services/healthService.js';

const healthRouter = Router();

healthRouter.get('/', (_request, response) => {
  response.status(200).json(getHealth());
});

export { healthRouter };
