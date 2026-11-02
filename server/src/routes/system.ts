import { Router } from 'express';
import { z } from 'zod';
import { audited, readAudit } from '../audit';
import {
  getListeningPorts,
  getMetricsHistory,
  getOverview,
  getProcesses,
  killProcess,
  killSignals,
} from '../services/system';
import { asyncHandler } from '../utils/http';

export const systemRouter = Router();

systemRouter.get(
  '/overview',
  asyncHandler(async (_req, res) => {
    res.json(await getOverview());
  }),
);

systemRouter.get('/metrics', (_req, res) => {
  res.json(getMetricsHistory());
});

systemRouter.get(
  '/processes',
  asyncHandler(async (_req, res) => {
    res.json(await getProcesses());
  }),
);

const killSchema = z.object({ signal: z.enum(killSignals as [string, ...string[]]).default('SIGTERM') });

systemRouter.post(
  '/processes/:pid/kill',
  asyncHandler(async (req, res) => {
    const pid = z.coerce.number().int().positive().parse(req.params.pid);
    const { signal } = killSchema.parse(req.body ?? {});
    await audited(req, `process.${signal.toLowerCase()}`, String(pid), async () =>
      killProcess(pid, signal as (typeof killSignals)[number]),
    );
    res.json({ ok: true });
  }),
);

systemRouter.get(
  '/ports',
  asyncHandler(async (_req, res) => {
    res.json(await getListeningPorts());
  }),
);

systemRouter.get('/audit', (req, res) => {
  const limit = z.coerce.number().int().min(1).max(1000).catch(200).parse(req.query.limit);
  res.json(readAudit(limit));
});
