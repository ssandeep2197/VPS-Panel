import { Router } from 'express';
import fs from 'fs';
import { audited } from '../audit';
import { assertHost, captureThumbnail, checkAll, getReport, thumbnailPath } from '../services/sites';
import { asyncHandler, HttpError } from '../utils/http';

export const sitesRouter = Router();

sitesRouter.get('/', (_req, res) => {
  res.json(getReport());
});

sitesRouter.post(
  '/refresh',
  asyncHandler(async (_req, res) => {
    res.json(await checkAll());
  }),
);

sitesRouter.get(
  '/:host/thumbnail',
  asyncHandler(async (req, res) => {
    let file: string;
    try {
      file = thumbnailPath(assertHost(req.params.host));
    } catch {
      throw new HttpError(400, 'Invalid hostname');
    }
    if (!fs.existsSync(file)) throw new HttpError(404, 'No screenshot yet');
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.type('png').sendFile(file);
  }),
);

sitesRouter.post(
  '/:host/thumbnail',
  asyncHandler(async (req, res) => {
    let host: string;
    try {
      host = assertHost(req.params.host);
    } catch {
      throw new HttpError(400, 'Invalid hostname');
    }
    if (!getReport().sites.some((s) => s.host === host)) throw new HttpError(404, 'Unknown site');
    req.setTimeout(90_000);
    const at = await audited(req, 'site.screenshot', host, () => captureThumbnail(host));
    res.json({ ok: true, thumbnailAt: at });
  }),
);
