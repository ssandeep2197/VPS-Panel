import { Router } from 'express';
import { z } from 'zod';
import { audited } from '../audit';
import { controlService, getService, listServices, serviceActions } from '../services/systemd';
import { asyncHandler } from '../utils/http';

export const servicesRouter = Router();

servicesRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(await listServices());
  }),
);

servicesRouter.get(
  '/:name',
  asyncHandler(async (req, res) => {
    res.json(await getService(req.params.name));
  }),
);

servicesRouter.post(
  '/:name/:action',
  asyncHandler(async (req, res) => {
    const action = z.enum(serviceActions).parse(req.params.action);
    const { name } = req.params;
    await audited(req, `service.${action}`, name, () => controlService(name, action));
    res.json(await getService(name));
  }),
);
