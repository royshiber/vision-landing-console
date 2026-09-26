/**
 * GET /api/autoland/status — display only.
 * No enable route. A missing companion report stays unreported.
 */

import { absentAutolandStatus, normalizeAutolandStatus } from '../autoland-status.mjs';

export function registerAutolandApi(app, ctx) {
  app.get('/api/autoland/status', async (_req, res) => {
    const client = ctx.companionService?.client || ctx.companionClient || null;
    if (!client || typeof client.getStatusAutoland !== 'function') {
      return res.json(absentAutolandStatus());
    }
    try {
      const data = await client.getStatusAutoland();
      return res.json(normalizeAutolandStatus(data));
    } catch {
      return res.json(absentAutolandStatus());
    }
  });
}
