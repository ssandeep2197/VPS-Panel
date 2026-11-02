import { Router } from 'express';
import { z } from 'zod';
import { audited } from '../audit';
import {
  createTopic,
  deleteGroup,
  deleteTopic,
  getCluster,
  getGroup,
  getTopic,
  listGroups,
  listTopics,
  peekMessages,
  produceMessage,
} from '../services/kafka';
import { asyncHandler } from '../utils/http';

export const kafkaRouter = Router();

kafkaRouter.get(
  '/cluster',
  asyncHandler(async (_req, res) => {
    res.json(await getCluster());
  }),
);

kafkaRouter.get(
  '/topics',
  asyncHandler(async (_req, res) => {
    res.json(await listTopics());
  }),
);

const createSchema = z.object({
  name: z.string().min(1).max(249),
  partitions: z.number().int().min(1).max(1000).default(1),
  replicationFactor: z.number().int().min(1).max(20).default(1),
});

kafkaRouter.post(
  '/topics',
  asyncHandler(async (req, res) => {
    const { name, partitions, replicationFactor } = createSchema.parse(req.body);
    await audited(req, 'kafka.topic.create', name, () => createTopic(name, partitions, replicationFactor));
    res.status(201).json({ ok: true });
  }),
);

kafkaRouter.get(
  '/topics/:name',
  asyncHandler(async (req, res) => {
    res.json(await getTopic(req.params.name));
  }),
);

kafkaRouter.delete(
  '/topics/:name',
  asyncHandler(async (req, res) => {
    const { name } = req.params;
    await audited(req, 'kafka.topic.delete', name, () => deleteTopic(name));
    res.json({ ok: true });
  }),
);

kafkaRouter.get(
  '/topics/:name/messages',
  asyncHandler(async (req, res) => {
    const limit = z.coerce.number().int().min(1).max(100).catch(20).parse(req.query.limit);
    res.json(await peekMessages(req.params.name, limit));
  }),
);

const produceSchema = z.object({
  key: z.string().max(1000).nullish(),
  value: z.string().max(1_000_000),
});

kafkaRouter.post(
  '/topics/:name/messages',
  asyncHandler(async (req, res) => {
    const { key, value } = produceSchema.parse(req.body);
    const { name } = req.params;
    await audited(req, 'kafka.message.produce', name, () => produceMessage(name, key ?? null, value));
    res.status(201).json({ ok: true });
  }),
);

kafkaRouter.get(
  '/groups',
  asyncHandler(async (_req, res) => {
    res.json(await listGroups());
  }),
);

kafkaRouter.get(
  '/groups/:id',
  asyncHandler(async (req, res) => {
    res.json(await getGroup(req.params.id));
  }),
);

kafkaRouter.delete(
  '/groups/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    await audited(req, 'kafka.group.delete', id, () => deleteGroup(id));
    res.json({ ok: true });
  }),
);
