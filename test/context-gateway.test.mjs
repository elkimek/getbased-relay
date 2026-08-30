import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let server, verifierServer, requestIp, port, ownerId, writeKey, token, tokenHash, dataDir;

function sha256Hex(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function signContext({ profileId = 'default', context, timestamp, tokenHash: hash = tokenHash }) {
  const contextHash = sha256Hex(context);
  return createHmac('sha256', writeKey)
    .update(`agent-context:${ownerId}:${timestamp}:${hash}:${profileId}:${contextHash}`)
    .digest('hex');
}

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'context-gateway-data-'));
  mkdirSync(dataDir, { recursive: true });
  const ownerBytes = randomBytes(16);
  ownerId = ownerBytes.toString('base64url');
  writeKey = randomBytes(32);

  token = 'a'.repeat(64);
  tokenHash = sha256Hex(token);
  port = 15000 + Math.floor(Math.random() * 1000);
  const verifierSocket = join(dataDir, 'verifier.sock');
  verifierServer = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const message = `agent-context:${body.ownerId}:${body.timestamp}:${body.tokenHash}:${body.profileId}:${body.contextHash}`;
      const expected = createHmac('sha256', writeKey).update(message).digest('hex');
      const ok = req.headers.authorization === 'Bearer verifier-test-token'
        && body.ownerId === ownerId
        && body.signature === expected;
      res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok }));
    });
  });
  await new Promise((resolve, reject) => {
    verifierServer.listen(verifierSocket, resolve);
    verifierServer.on('error', reject);
  });
  process.env.CONTEXT_DATA_DIR = dataDir;
  process.env.CONTEXT_VERIFIER_SOCKET = verifierSocket;
  process.env.CONTEXT_VERIFIER_TOKEN = 'verifier-test-token';
  process.env.CONTEXT_CLIENT_IP_HEADER = 'x-getbased-client-ip';
  process.env.CONTEXT_PORT = String(port);
  process.env.AGENT_CONTEXT_OWNER_QUOTA_BYTES = '2000';
  process.env.AGENT_CONTEXT_MAX_PROFILE_BYTES = '1000';
  process.env.AGENT_CONTEXT_MAX_PROFILES = '3';
  process.env.AGENT_CONTEXT_MAX_TOKENS = '2';
  ({ server, requestIp } = await import('../context-gateway/server.js?test=' + Date.now()));
  await new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', resolve);
    server.on('error', reject);
  });
});

after(async () => {
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  if (verifierServer?.listening) await new Promise(resolve => verifierServer.close(resolve));
});

test('owner-bound context POST stores under owner, not raw token namespace', async () => {
  const profileId = 'p1';
  const context = JSON.stringify({ encryptedContext: { version: 2, ciphertext: 'abc' } });
  const timestamp = Date.now();
  const signature = signContext({ profileId, context, timestamp });
  const post = await fetch(`http://127.0.0.1:${port}/api/context`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerId, profileId, context, timestamp, signature }),
  });
  assert.equal(post.status, 200);
  const postBody = await post.json();
  assert.equal(postBody.ownerId, ownerId);
  assert.equal(typeof postBody.ownerBytes, 'number');

  const get = await fetch(`http://127.0.0.1:${port}/api/context?profile=p1`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(get.status, 200);
  const body = await get.json();
  assert.equal(body.profileId, 'p1');
  assert.equal(body.context, context);
});

test('wrong owner signature is rejected and creates no token mapping', async () => {
  const badToken = 'b'.repeat(64);
  const profileId = 'bad';
  const context = JSON.stringify({ encryptedContext: { version: 2, ciphertext: 'bad' } });
  const timestamp = Date.now();
  const wrongHash = sha256Hex(badToken);
  const signature = signContext({ profileId, context, timestamp, tokenHash: '0'.repeat(64) });
  assert.notEqual(wrongHash, '0'.repeat(64));
  const post = await fetch(`http://127.0.0.1:${port}/api/context`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${badToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerId, profileId, context, timestamp, signature }),
  });
  assert.equal(post.status, 401);

  const get = await fetch(`http://127.0.0.1:${port}/api/context`, {
    headers: { Authorization: `Bearer ${badToken}` },
  });
  assert.equal(get.status, 404);
});

test('owner token and profile limits are enforced', async () => {
  const token2 = 'c'.repeat(64);
  const token3 = 'd'.repeat(64);
  for (const [tok, profileId] of [[token2, 'p2']]) {
    const context = JSON.stringify({ encryptedContext: { version: 2, ciphertext: profileId } });
    const timestamp = Date.now();
    const signature = signContext({ profileId, context, timestamp, tokenHash: sha256Hex(tok) });
    const post = await fetch(`http://127.0.0.1:${port}/api/context`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ownerId, profileId, context, timestamp, signature }),
    });
    assert.equal(post.status, 200);
  }

  const context = JSON.stringify({ encryptedContext: { version: 2, ciphertext: 'p3' } });
  const timestamp = Date.now();
  const signature = signContext({ profileId: 'p3', context, timestamp, tokenHash: sha256Hex(token3) });
  const post = await fetch(`http://127.0.0.1:${port}/api/context`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token3}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerId, profileId: 'p3', context, timestamp, signature }),
  });
  assert.equal(post.status, 409);
  const body = await post.json();
  assert.equal(body.error, 'token_limit_exceeded');

  const context2 = JSON.stringify({ encryptedContext: { version: 2, ciphertext: 'p3' } });
  const timestamp2 = Date.now();
  const signature2 = signContext({ profileId: 'p3', context: context2, timestamp: timestamp2, tokenHash: sha256Hex(token2) });
  const post2 = await fetch(`http://127.0.0.1:${port}/api/context`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token2}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerId, profileId: 'p3', context: context2, timestamp: timestamp2, signature: signature2 }),
  });
  assert.equal(post2.status, 200);

  const context3 = JSON.stringify({ encryptedContext: { version: 2, ciphertext: 'p4' } });
  const timestamp3 = Date.now();
  const signature3 = signContext({ profileId: 'p4', context: context3, timestamp: timestamp3, tokenHash: sha256Hex(token2) });
  const post3 = await fetch(`http://127.0.0.1:${port}/api/context`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token2}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerId, profileId: 'p4', context: context3, timestamp: timestamp3, signature: signature3 }),
  });
  assert.equal(post3.status, 409);
  const body3 = await post3.json();
  assert.equal(body3.error, 'profile_limit_exceeded');
});

test('health endpoint works without token for docker healthchecks', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
});

test('rate-limit identity ignores X-Forwarded-For and validates the dedicated header', () => {
  const req = {
    socket: { remoteAddress: '::ffff:172.18.0.1' },
    headers: {
      'x-forwarded-for': '198.51.100.99',
      'x-getbased-client-ip': '203.0.113.7',
    },
  };
  assert.equal(requestIp(req), '203.0.113.7');
  req.headers['x-getbased-client-ip'] = '203.0.113.7, 198.51.100.1';
  assert.equal(requestIp(req), '172.18.0.1');
});

test('malformed legacy context file returns 404 instead of crashing server', async () => {
  const legacyToken = 'legacy-malformed-token';
  const legacyPath = join(dataDir, Buffer.from(legacyToken).toString('base64url').slice(0, 32) + '.json');
  writeFileSync(legacyPath, '{not-json');

  const res = await fetch(`http://127.0.0.1:${port}/api/context`, {
    headers: { Authorization: `Bearer ${legacyToken}` },
  });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'No context found for this token');

  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
});

test('write-key rotation is picked up by the verifier without restarting the gateway', async () => {
  const rotatedWriteKey = randomBytes(32);
  writeKey = rotatedWriteKey;

  const profileId = 'p1';
  const context = JSON.stringify({ encryptedContext: { version: 2, ciphertext: 'rotated' } });
  const timestamp = Date.now();
  const signature = signContext({ profileId, context, timestamp });
  const res = await fetch(`http://127.0.0.1:${port}/api/context`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerId, profileId, context, timestamp, signature }),
  });
  assert.equal(res.status, 200);
});
