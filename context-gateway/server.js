import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DATA_DIR = '/opt/context-gateway/data';
mkdirSync(DATA_DIR, { recursive: true });

const server = createServer((req, res) => {
  // CORS headers on every response
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

  // Preflight — respond immediately, no auth needed
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ') || auth.length < 20) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing or invalid token' }));
    return;
  }

  const token = auth.slice(7);
  const hash = Buffer.from(token).toString('base64url').slice(0, 32);
  const filePath = join(DATA_DIR, hash + '.json');

  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'POST' && url.pathname === '/api/context') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        if (body.length > 500000) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Payload too large' }));
          return;
        }
        const data = JSON.parse(body);
        if (!data.context || typeof data.context !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing context field' }));
          return;
        }

        // Load existing file to preserve other profiles
        let stored = {};
        if (existsSync(filePath)) {
          try { stored = JSON.parse(readFileSync(filePath, 'utf8')); } catch {}
        }

        const profileId = data.profileId || 'default';

        // Migrate: if old format (flat context), move it into contexts map
        if (stored.context && !stored.contexts) {
          stored.contexts = { default: stored.context };
          delete stored.context;
        }
        if (!stored.contexts) stored.contexts = {};

        stored.contexts[profileId] = data.context;
        stored.profiles = data.profiles || stored.profiles || null;
        stored.updatedAt = new Date().toISOString();

        writeFileSync(filePath, JSON.stringify(stored));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/context') {
    if (!existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No context found for this token' }));
      return;
    }
    const stored = JSON.parse(readFileSync(filePath, 'utf8'));
    const requestedProfile = url.searchParams.get('profile');

    // New format: per-profile contexts
    if (stored.contexts) {
      if (requestedProfile) {
        // Return specific profile
        const ctx = stored.contexts[requestedProfile];
        if (!ctx) {
          const available = Object.keys(stored.contexts);
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Profile "${requestedProfile}" not found`, available }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          context: ctx,
          profileId: requestedProfile,
          profiles: stored.profiles,
          updatedAt: stored.updatedAt,
        }));
      } else {
        // No profile requested — return default (first) profile for backward compat
        const defaultKey = stored.contexts.default ? 'default' : Object.keys(stored.contexts)[0];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          context: stored.contexts[defaultKey] || '',
          profileId: defaultKey,
          profiles: stored.profiles,
          updatedAt: stored.updatedAt,
        }));
      }
      return;
    }

    // Old format: flat context (backward compat)
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stored));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(4001, '127.0.0.1', () => {
  console.log('Context gateway running on :4001');
});
