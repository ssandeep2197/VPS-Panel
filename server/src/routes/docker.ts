import { Router } from 'express';
import { z } from 'zod';
import { audited } from '../audit';
import {
  allContainerStats,
  containerActions,
  controlContainer,
  getInfo,
  inspectContainer,
  listContainers,
  listImages,
  listNetworks,
  listVolumes,
  pullImage,
  removeContainer,
  removeImage,
  removeVolume,
} from '../services/docker';
import { asyncHandler } from '../utils/http';

export const dockerRouter = Router();

const force = (value: unknown) => value === '1' || value === 'true';

dockerRouter.get(
  '/info',
  asyncHandler(async (_req, res) => {
    res.json(await getInfo());
  }),
);

dockerRouter.get(
  '/containers',
  asyncHandler(async (_req, res) => {
    res.json(await listContainers());
  }),
);

dockerRouter.get(
  '/stats',
  asyncHandler(async (_req, res) => {
    res.json(await allContainerStats());
  }),
);

dockerRouter.get(
  '/containers/:id',
  asyncHandler(async (req, res) => {
    res.json(await inspectContainer(req.params.id));
  }),
);

dockerRouter.post(
  '/containers/:id/:action',
  asyncHandler(async (req, res) => {
    const action = z.enum(containerActions).parse(req.params.action);
    const { id } = req.params;
    const label = typeof req.body?.name === 'string' ? req.body.name.slice(0, 100) : id.slice(0, 12);
    await audited(req, `container.${action}`, label, () => controlContainer(id, action));
    res.json({ ok: true });
  }),
);

dockerRouter.delete(
  '/containers/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    await audited(req, 'container.remove', id.slice(0, 12), () => removeContainer(id, force(req.query.force)));
    res.json({ ok: true });
  }),
);

dockerRouter.get(
  '/images',
  asyncHandler(async (_req, res) => {
    res.json(await listImages());
  }),
);

dockerRouter.post(
  '/images/pull',
  asyncHandler(async (req, res) => {
    const { image } = z.object({ image: z.string().min(1).max(255) }).parse(req.body);
    // Pulls can take minutes on a slow link
    req.setTimeout(15 * 60 * 1000);
    await audited(req, 'image.pull', image, () => pullImage(image));
    res.json({ ok: true });
  }),
);

dockerRouter.delete(
  '/images/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    await audited(req, 'image.remove', id.slice(0, 19), () => removeImage(id, force(req.query.force)));
    res.json({ ok: true });
  }),
);

dockerRouter.get(
  '/volumes',
  asyncHandler(async (_req, res) => {
    res.json(await listVolumes());
  }),
);

dockerRouter.delete(
  '/volumes/:name',
  asyncHandler(async (req, res) => {
    const { name } = req.params;
    await audited(req, 'volume.remove', name, () => removeVolume(name));
    res.json({ ok: true });
  }),
);

dockerRouter.get(
  '/networks',
  asyncHandler(async (_req, res) => {
    res.json(await listNetworks());
  }),
);
