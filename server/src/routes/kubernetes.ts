import { Router } from 'express';
import { z } from 'zod';
import { audited } from '../audit';
import {
  deletePod,
  getOverview,
  listIngresses,
  listPods,
  listWarnings,
  listWorkloads,
  restartWorkload,
  scaleWorkload,
  workloadKinds,
} from '../services/kubernetes';
import { asyncHandler } from '../utils/http';

export const kubernetesRouter = Router();

kubernetesRouter.get(
  '/overview',
  asyncHandler(async (_req, res) => {
    res.json(await getOverview());
  }),
);

kubernetesRouter.get(
  '/workloads',
  asyncHandler(async (_req, res) => {
    res.json(await listWorkloads());
  }),
);

kubernetesRouter.post(
  '/workloads/:kind/:namespace/:name/restart',
  asyncHandler(async (req, res) => {
    const kind = z.enum(workloadKinds).parse(req.params.kind);
    const { namespace, name } = req.params;
    await audited(req, `k8s.${kind}.restart`, `${namespace}/${name}`, () =>
      restartWorkload(kind, namespace, name),
    );
    res.json({ ok: true });
  }),
);

kubernetesRouter.post(
  '/workloads/:kind/:namespace/:name/scale',
  asyncHandler(async (req, res) => {
    const kind = z.enum(workloadKinds).parse(req.params.kind);
    const { replicas } = z.object({ replicas: z.number().int().min(0).max(50) }).parse(req.body);
    const { namespace, name } = req.params;
    await audited(req, `k8s.${kind}.scale`, `${namespace}/${name} -> ${replicas}`, () =>
      scaleWorkload(kind, namespace, name, replicas),
    );
    res.json({ ok: true });
  }),
);

kubernetesRouter.get(
  '/pods',
  asyncHandler(async (_req, res) => {
    res.json(await listPods());
  }),
);

kubernetesRouter.delete(
  '/pods/:namespace/:name',
  asyncHandler(async (req, res) => {
    const { namespace, name } = req.params;
    await audited(req, 'k8s.pod.delete', `${namespace}/${name}`, () => deletePod(namespace, name));
    res.json({ ok: true });
  }),
);

kubernetesRouter.get(
  '/ingresses',
  asyncHandler(async (_req, res) => {
    res.json(await listIngresses());
  }),
);

kubernetesRouter.get(
  '/events',
  asyncHandler(async (_req, res) => {
    res.json(await listWarnings());
  }),
);
