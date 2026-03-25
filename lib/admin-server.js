// admin-server.js — Health and metrics HTTP endpoints on a separate port

import { createServer } from 'http';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

export function createAdminServer(config, logger, metrics, ownerTracker) {
  const startTime = Date.now();

  function handleHealth(_req, res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      version: pkg.version,
    }));
  }

  function handleMetrics(_req, res) {
    const perOwner = metrics.getPerOwnerUsage();
    const activity = ownerTracker.getActivity();
    const stale = ownerTracker.getStaleOwners();

    // Merge usage + last-seen
    const owners = perOwner.map(o => ({
      ...o,
      lastSeen: activity[o.ownerId] || null,
    }));

    const body = {
      uptime: Math.floor((Date.now() - startTime) / 1000),
      version: pkg.version,
      connections: logger.getCurrentConnections(),
      owners: {
        total: metrics.getOwnerCount(),
        stale: stale.length,
        totalStoredBytes: metrics.getTotalStoredBytes(),
      },
      perOwner: owners,
      disk: {
        dbFileSizeBytes: metrics.getDbFileSize(),
      },
      quota: {
        perOwnerBytes: config.quotaPerOwnerBytes,
        globalBytes: config.quotaGlobalBytes,
      },
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body, null, 2));
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${config.adminPort}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      return handleHealth(req, res);
    }
    if (req.method === 'GET' && url.pathname === '/metrics') {
      return handleMetrics(req, res);
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  function start() {
    return new Promise((resolve, reject) => {
      server.listen(config.adminPort, () => {
        logger.emit('info', 'admin.started', { port: config.adminPort });
        resolve();
      });
      server.on('error', reject);
    });
  }

  function stop() {
    return new Promise(resolve => server.close(resolve));
  }

  return { start, stop };
}
