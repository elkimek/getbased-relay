import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let server, verifierServer, requestIp, port, ownerId, writeKey, token, tokenHash, dataDir;

function sha256Hex(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function bearer(value) {
  return ['Bear', 'er ', value].join('');
}

function signContext({ profileId = 'default', context, timestamp, tokenHash: hash = tokenHash }) {
  const contextHash = sha256Hex(context);
  return createHmac('sha256', writeKey)
    .update(`agent-context:${ownerId}:${timestamp}:${hash}:${profileId}:${contextHash}`)
    .digest('hex');
}

function proposalIdFromIv(iv) {
  return `proposal_${createHash('sha256').update(iv).digest('base64url').slice(0, 24)}`;
}

function validProposalEnvelope(ivByte = 7) {
  const iv = Buffer.alloc(12, ivByte);
  return {
    version: 1,
    alg: 'AES-256-GCM',
    keyDerivation: 'raw-256-bit-key',
    keyId: 'AAECAwQFBgcICQoL',
    proposalId: proposalIdFromIv(iv),
    iv: iv.toString('base64'),
    ciphertext: Buffer.alloc(64, 9).toString('base64'),
  };
}

function ownerProposalStorageBudget() {
  const owner = JSON.parse(readFileSync(join(dataDir, 'owners', `${ownerId}.json`), 'utf8'));
  const sizes = Object.values(owner.contexts || {}).map(value => Buffer.byteLength(String(value || ''), 'utf8'));
  const currentContextBytes = sizes.reduce((sum, size) => sum + size, 0);
  const reservedContextBytes = sizes.length < 3
    ? currentContextBytes + 1000
    : currentContextBytes - Math.min(...sizes) + 1000;
  return Math.max(0, 2000 - reservedContextBytes);
}

function contextWithExactBytes(size, keyId) {
  const prefix = `{"encryptedContext":{"version":2,"keyId":"${keyId}","ciphertext":"`;
  const suffix = '"}}';
  const padding = size - Buffer.byteLength(prefix + suffix, 'utf8');
  assert.ok(padding >= 0);
  const value = `${prefix}${'x'.repeat(padding)}${suffix}`;
  assert.equal(Buffer.byteLength(value, 'utf8'), size);
  return value;
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
  process.env.AGENT_PROPOSAL_MAX_TRACKED = '999';
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
  const context = JSON.stringify({
    encryptedContext: {
      version: 2,
      keyId: validProposalEnvelope().keyId,
      ciphertext: 'abc',
    },
  });
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

test('token-bound proposal queue stores only a strict ciphertext envelope', async () => {
  const envelope = validProposalEnvelope();
  const post = await fetch(`http://127.0.0.1:${port}/api/agent-proposals`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ envelope }),
  });
  assert.equal(post.status, 201);
  assert.deepEqual(await post.json(), {
    ok: true,
    proposalId: envelope.proposalId,
    duplicate: false,
  });

  const get = await fetch(`http://127.0.0.1:${port}/api/agent-proposals`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(get.status, 200);
  const body = await get.json();
  assert.equal(body.proposals.length, 1);
  assert.equal(body.proposals[0].proposalId, envelope.proposalId);
  assert.deepEqual(body.proposals[0].envelope, envelope);
  assert.equal(typeof body.proposals[0].createdAt, 'string');
  assert.doesNotMatch(JSON.stringify(body), /Sunbathing|durationMinutes|profileId/);
});

test('proposal submission is idempotent and conflicting ciphertext is rejected', async () => {
  const envelope = validProposalEnvelope();
  const duplicate = await fetch(`http://127.0.0.1:${port}/api/agent-proposals`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ envelope }),
  });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).duplicate, true);

  const conflictEnvelope = { ...envelope, ciphertext: Buffer.alloc(64, 4).toString('base64') };
  const conflict = await fetch(`http://127.0.0.1:${port}/api/agent-proposals`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ envelope: conflictEnvelope }),
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error, 'proposal_id_conflict');
});

test('proposal queue rejects caller-controlled plaintext metadata', async () => {
  const envelope = validProposalEnvelope(8);
  const semanticId = await fetch(`http://127.0.0.1:${port}/api/agent-proposals`, {
    method: 'POST',
    headers: { Authorization: bearer(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      envelope: { ...envelope, proposalId: 'proposal_Sunbathing_60min' },
    }),
  });
  assert.equal(semanticId.status, 400);
  assert.equal((await semanticId.json()).error, 'invalid_proposal_envelope');

  const semanticKey = await fetch(`http://127.0.0.1:${port}/api/agent-proposals`, {
    method: 'POST',
    headers: { Authorization: bearer(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      envelope: { ...envelope, keyId: 'Sunbathing60min_' },
    }),
  });
  assert.equal(semanticKey.status, 400);
  assert.equal((await semanticKey.json()).error, 'invalid_proposal_envelope');
});

test('proposal queue rejects plaintext-shaped and unmapped submissions', async () => {
  const plaintext = await fetch(`http://127.0.0.1:${port}/api/agent-proposals`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      envelope: {
        ...validProposalEnvelope(9),
        payload: { durationMinutes: 60 },
      },
    }),
  });
  assert.equal(plaintext.status, 400);
  assert.equal((await plaintext.json()).error, 'invalid_proposal_envelope');

  const unmapped = await fetch(`http://127.0.0.1:${port}/api/agent-proposals`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${'f'.repeat(64)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ envelope: validProposalEnvelope(10) }),
  });
  assert.equal(unmapped.status, 404);
  assert.equal((await unmapped.json()).error, 'agent_access_not_registered');
});

test('a token can acknowledge only its own queued proposal', async () => {
  const proposalId = validProposalEnvelope().proposalId;
  const remove = await fetch(`http://127.0.0.1:${port}/api/agent-proposals/${proposalId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(remove.status, 200);
  assert.deepEqual(await remove.json(), { ok: true, deleted: true });

  const get = await fetch(`http://127.0.0.1:${port}/api/agent-proposals`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(get.status, 200);
  assert.deepEqual((await get.json()).proposals, []);
});

test('an acknowledged proposal id cannot be queued again', async () => {
  const envelope = validProposalEnvelope(11);
  const profileId = 'p1';
  const context = JSON.stringify({
    encryptedContext: { version: 2, keyId: envelope.keyId, ciphertext: 'abc' },
  });
  const timestamp = Date.now();
  const signature = signContext({ profileId, context, timestamp });
  const registered = await fetch(`http://127.0.0.1:${port}/api/context`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerId, profileId, context, timestamp, signature }),
  });
  assert.equal(registered.status, 200);

  const created = await fetch(`http://127.0.0.1:${port}/api/agent-proposals`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ envelope }),
  });
  assert.equal(created.status, 201);

  const acknowledged = await fetch(
    `http://127.0.0.1:${port}/api/agent-proposals/${envelope.proposalId}`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
  );
  assert.equal(acknowledged.status, 200);

  const replayed = await fetch(`http://127.0.0.1:${port}/api/agent-proposals`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ envelope }),
  });
  assert.equal(replayed.status, 200);
  assert.equal((await replayed.json()).duplicate, true);

  const remaining = await fetch(`http://127.0.0.1:${port}/api/agent-proposals`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.deepEqual((await remaining.json()).proposals, []);
});

test('owner proposal byte reserve rejects a large pending envelope before context capacity is consumed', async () => {
  const envelope = {
    ...validProposalEnvelope(18),
    ciphertext: Buffer.alloc(300, 7).toString('base64url'),
  };
  const rejected = await fetch(`http://127.0.0.1:${port}/api/agent-proposals`, {
    method: 'POST',
    headers: { Authorization: bearer(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ envelope }),
  });
  assert.equal(rejected.status, 409);
  assert.deepEqual(await rejected.json(), {
    error: 'proposal_owner_storage_limit_exceeded',
    maxProposalStorageBytes: ownerProposalStorageBudget(),
  });

  const profileId = 'p1';
  const context = JSON.stringify({
    encryptedContext: {
      version: 2,
      keyId: validProposalEnvelope().keyId,
      ciphertext: 'still-writable-after-large-pending',
    },
  });
  const timestamp = Date.now();
  const signature = signContext({ profileId, context, timestamp });
  const writable = await fetch(`http://127.0.0.1:${port}/api/context`, {
    method: 'POST',
    headers: { Authorization: bearer(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerId, profileId, context, timestamp, signature }),
  });
  assert.equal(writable.status, 200);
});

test('owner proposal storage limit preserves context capacity when configured count is too high', async () => {
  for (const ivByte of [12]) {
    const envelope = validProposalEnvelope(ivByte);
    const created = await fetch(`http://127.0.0.1:${port}/api/agent-proposals`, {
      method: 'POST',
      headers: { Authorization: bearer(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ envelope }),
    });
    assert.equal(created.status, 201);
    const acknowledged = await fetch(
      `http://127.0.0.1:${port}/api/agent-proposals/${envelope.proposalId}`,
      { method: 'DELETE', headers: { Authorization: bearer(token) } },
    );
    assert.equal(acknowledged.status, 200);
  }

  const blocked = await fetch(`http://127.0.0.1:${port}/api/agent-proposals`, {
    method: 'POST',
    headers: { Authorization: bearer(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ envelope: validProposalEnvelope(13) }),
  });
  assert.equal(blocked.status, 409);
  assert.deepEqual(await blocked.json(), {
    error: 'proposal_owner_storage_limit_exceeded',
    maxProposalStorageBytes: ownerProposalStorageBudget(),
  });

  const profileId = 'p1';
  const context = contextWithExactBytes(1000, validProposalEnvelope().keyId);
  const timestamp = Date.now();
  const signature = signContext({ profileId, context, timestamp });
  const contextWrite = await fetch(`http://127.0.0.1:${port}/api/context`, {
    method: 'POST',
    headers: { Authorization: bearer(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerId, profileId, context, timestamp, signature }),
  });
  assert.equal(contextWrite.status, 200);
});

test('compose documents the proposal limit names consumed by the gateway runtime', () => {
  const compose = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
  assert.match(compose, /AGENT_PROPOSAL_MAX_CIPHERTEXT_BYTES=65536/);
  assert.match(compose, /AGENT_PROPOSAL_MAX_TRACKED=256/);
  assert.match(compose, /AGENT_PROPOSAL_RETENTION_MS=86400000/);
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
