// Run with docker exec against the gateway's normal entrypoint and data directory.
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';

const baseUrl = 'http://127.0.0.1:4001';
const socket = process.env.CONTEXT_VERIFIER_SOCKET;
const verifierToken = process.env.CONTEXT_VERIFIER_TOKEN;
assert.ok(socket && verifierToken, 'Configure the gateway verifier for the image check');
assert.notEqual(process.getuid(), 0, 'Run the gateway check as the image service user');

const ownerId = randomBytes(16).toString('base64url');
const writeKey = randomBytes(32);
const token = randomBytes(32).toString('hex');
const hash = value => createHash('sha256').update(value).digest('hex');
const tokenHash = hash(token);
const profileId = 'ci';
const context = JSON.stringify({ encryptedContext: { version: 2, ciphertext: 'synthetic-ci-context' } });
const message = body => `agent-context:${body.ownerId}:${body.timestamp}:${body.tokenHash}:${body.profileId}:${body.contextHash}`;
const sign = body => createHmac('sha256', writeKey).update(message(body)).digest('hex');
let verifiedRequests = 0;

const verifier = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const ok = req.method === 'POST' && req.url === '/verify-agent-context'
      && req.headers.authorization === `Bearer ${verifierToken}`
      && body.ownerId === ownerId && body.tokenHash === tokenHash
      && body.signature === sign(body);
    if (ok) verifiedRequests++;
    res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok }));
  } catch {
    res.writeHead(400);
    res.end();
  }
});

function proof(profile, value) {
  const body = { ownerId, timestamp: Date.now(), tokenHash, profileId: profile, contextHash: hash(value) };
  return { ownerId, timestamp: body.timestamp, profileId: profile, context: value, signature: sign(body) };
}

async function request(method, body) {
  return fetch(`${baseUrl}/api/context`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
}

try {
  let health;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) }); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.equal(health?.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
  const invalid = await request('POST', null);
  assert.equal(invalid.status, 400);
  await invalid.arrayBuffer();

  await new Promise((resolve, reject) => {
    verifier.once('error', reject);
    verifier.listen(socket, resolve);
  });
  const unauthorized = await request('POST', { ...proof(profileId, context), signature: '0'.repeat(64) });
  assert.equal(unauthorized.status, 401);
  await unauthorized.arrayBuffer();
  const upload = await request('POST', proof(profileId, context));
  assert.equal(upload.status, 200, await upload.text());
  const dataDir = process.env.CONTEXT_DATA_DIR || '/opt/context-gateway/data';
  const stored = JSON.parse(await readFile(join(dataDir, 'owners', `${ownerId}.json`), 'utf8'));
  assert.equal(stored.contexts[profileId], context);
  assert.deepEqual(stored.tokens, [tokenHash]);

  const read = await fetch(`${baseUrl}/api/context?profile=${profileId}`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
  });
  assert.equal(read.status, 200);
  assert.equal((await read.json()).context, context);

  const revoke = await request('DELETE', proof('default', ''));
  assert.equal(revoke.status, 200);
  assert.equal((await revoke.json()).deleted, true);
  const revoked = await fetch(`${baseUrl}/api/context`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
  });
  assert.equal(revoked.status, 404);
  await revoked.arrayBuffer();
  assert.equal(verifiedRequests, 2, 'Upload and revocation must use the configured verifier');
  console.log('Gateway image: startup, validation, verified upload, persistence, read, and revocation passed');
} finally {
  if (verifier.listening) await new Promise(resolve => verifier.close(resolve));
  await rm(socket, { force: true });
}
