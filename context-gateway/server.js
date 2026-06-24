import { createServer } from 'node:http';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const DATA_DIR = process.env.CONTEXT_DATA_DIR || '/opt/context-gateway/data';
const EVOLU_DB_PATH = process.env.EVOLU_DB_PATH || '/data/evolu-relay.db';
const PORT = Number(process.env.CONTEXT_PORT || 4001);
const BIND = process.env.CONTEXT_BIND || '127.0.0.1';
const MAX_CONTEXT_BYTES = Number(process.env.AGENT_CONTEXT_MAX_PROFILE_BYTES || 512 * 1024);
const OWNER_QUOTA_BYTES = Number(process.env.AGENT_CONTEXT_OWNER_QUOTA_BYTES || 5 * 1024 * 1024);
const MAX_PROFILES_PER_OWNER = Number(process.env.AGENT_CONTEXT_MAX_PROFILES || 20);
const MAX_TOKENS_PER_OWNER = Number(process.env.AGENT_CONTEXT_MAX_TOKENS || 3);
const TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;

mkdirSync(DATA_DIR, { recursive: true });

const TOKEN_MAP_PATH = join(DATA_DIR, 'agent-token-map.json');
const OWNER_DIR = join(DATA_DIR, 'owners');
mkdirSync(OWNER_DIR, { recursive: true });

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sha256Hex(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function legacyTokenFile(token) {
  return join(DATA_DIR, Buffer.from(token).toString('base64url').slice(0, 32) + '.json');
}

function ownerPath(ownerId) {
  return join(OWNER_DIR, `${ownerId}.json`);
}

function safeReadJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function atomicWriteJson(path, value) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}

function readTokenMap() {
  const parsed = safeReadJson(TOKEN_MAP_PATH, {});
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function writeTokenMap(map) {
  atomicWriteJson(TOKEN_MAP_PATH, map);
}

function readOwner(ownerId) {
  const parsed = safeReadJson(ownerPath(ownerId), null);
  if (parsed && typeof parsed === 'object') {
    if (!parsed.contexts || typeof parsed.contexts !== 'object' || Array.isArray(parsed.contexts)) parsed.contexts = {};
    if (!Array.isArray(parsed.tokens)) parsed.tokens = [];
    return parsed;
  }
  return { ownerId, contexts: {}, profiles: null, tokens: [], updatedAt: null };
}

function writeOwner(ownerId, owner) {
  atomicWriteJson(ownerPath(ownerId), owner);
}

function contextBytes(contexts) {
  return Object.values(contexts || {}).reduce((n, value) => n + Buffer.byteLength(String(value || ''), 'utf8'), 0);
}

function decodeOwnerId(ownerId) {
  if (typeof ownerId !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(ownerId)) return null;
  try {
    const buf = Buffer.from(ownerId, 'base64url');
    return buf.length === 16 ? buf : null;
  } catch {
    return null;
  }
}

function safeEqualHex(aHex, bBuffer) {
  if (typeof aHex !== 'string' || !/^[0-9a-f]{64}$/i.test(aHex)) return false;
  const a = Buffer.from(aHex, 'hex');
  if (a.length !== bBuffer.length) return false;
  return timingSafeEqual(a, bBuffer);
}

function lookupWriteKey(ownerBytes) {
  if (!existsSync(EVOLU_DB_PATH)) return null;
  let db;
  try {
    db = new Database(EVOLU_DB_PATH, { fileMustExist: true, readonly: true });
    db.pragma('busy_timeout = 5000');
    const row = db
      .prepare('SELECT "writeKey" FROM evolu_writeKey WHERE "ownerId" = ?')
      .get(ownerBytes);
    return row?.writeKey ?? null;
  } finally {
    try { db?.close(); } catch {}
  }
}

function verifyOwnerSignature({ ownerId, timestamp, signature, tokenHash, profileId, context }) {
  const ownerBytes = decodeOwnerId(ownerId);
  if (!ownerBytes) return { ok: false, status: 400, error: 'invalid_owner_id' };
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > TIMESTAMP_WINDOW_MS) {
    return { ok: false, status: 401, error: 'timestamp_outside_window' };
  }
  const writeKey = lookupWriteKey(ownerBytes);
  const contextHash = sha256Hex(context);
  const message = `agent-context:${ownerId}:${timestamp}:${tokenHash}:${profileId || 'default'}:${contextHash}`;
  const expected = createHmac('sha256', writeKey ?? Buffer.alloc(32)).update(message).digest();
  if (!writeKey || !safeEqualHex(signature, expected)) {
    return { ok: false, status: 401, error: 'unauthorized' };
  }
  return { ok: true, ownerId, contextHash };
}

function authToken(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ') || auth.length < 20) return null;
  return auth.slice(7);
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        reject(new Error('payload_too_large'));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function handlePostContext(req, res, token, tokenHash) {
  let data;
  try {
    const body = await readBody(req, Math.max(MAX_CONTEXT_BYTES + 4096, 32 * 1024));
    data = JSON.parse(body);
  } catch (e) {
    const msg = e?.message === 'payload_too_large' ? 'Payload too large' : 'Invalid JSON';
    json(res, e?.message === 'payload_too_large' ? 413 : 400, { error: msg });
    return;
  }

  if (!data.context || typeof data.context !== 'string') {
    json(res, 400, { error: 'Missing context field' });
    return;
  }
  if (Buffer.byteLength(data.context, 'utf8') > MAX_CONTEXT_BYTES) {
    json(res, 413, { error: 'Context too large' });
    return;
  }
  const profileId = data.profileId || 'default';
  if (typeof profileId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(profileId)) {
    json(res, 400, { error: 'Invalid profileId — must be [a-zA-Z0-9_-]+' });
    return;
  }

  const proof = verifyOwnerSignature({
    ownerId: data.ownerId,
    timestamp: Number(data.timestamp),
    signature: data.signature,
    tokenHash,
    profileId,
    context: data.context,
  });
  if (!proof.ok) {
    json(res, proof.status, { error: proof.error });
    return;
  }

  const ownerId = proof.ownerId;
  const tokenMap = readTokenMap();
  const existingMapping = tokenMap[tokenHash];
  if (existingMapping && existingMapping.ownerId !== ownerId) {
    json(res, 409, { error: 'token_owner_mismatch' });
    return;
  }

  const owner = readOwner(ownerId);
  const profiles = Object.keys(owner.contexts || {});
  if (!owner.contexts[profileId] && profiles.length >= MAX_PROFILES_PER_OWNER) {
    json(res, 409, { error: 'profile_limit_exceeded', maxProfiles: MAX_PROFILES_PER_OWNER });
    return;
  }
  if (!owner.tokens.includes(tokenHash)) {
    if (owner.tokens.length >= MAX_TOKENS_PER_OWNER) {
      json(res, 409, { error: 'token_limit_exceeded', maxTokens: MAX_TOKENS_PER_OWNER });
      return;
    }
    owner.tokens.push(tokenHash);
  }

  const nextContexts = { ...owner.contexts, [profileId]: data.context };
  const nextBytes = contextBytes(nextContexts);
  if (nextBytes > OWNER_QUOTA_BYTES) {
    json(res, 413, { error: 'owner_quota_exceeded', ownerBytes: nextBytes, quotaBytes: OWNER_QUOTA_BYTES });
    return;
  }

  owner.contexts = nextContexts;
  owner.profiles = data.profiles || owner.profiles || null;
  owner.updatedAt = new Date().toISOString();
  owner.bytes = nextBytes;
  writeOwner(ownerId, owner);

  tokenMap[tokenHash] = { ownerId, createdAt: existingMapping?.createdAt || owner.updatedAt, updatedAt: owner.updatedAt };
  writeTokenMap(tokenMap);
  json(res, 200, { ok: true, ownerId, ownerBytes: nextBytes, quotaBytes: OWNER_QUOTA_BYTES });
}

function handleGetContext(req, res, token, tokenHash, url) {
  const tokenMap = readTokenMap();
  const mapping = tokenMap[tokenHash];
  if (!mapping?.ownerId) {
    // Backward compatibility for pre-owner-bound token-keyed files.
    const legacyPath = legacyTokenFile(token);
    if (!existsSync(legacyPath)) {
      json(res, 404, { error: 'No context found for this token' });
      return;
    }
    const stored = safeReadJson(legacyPath, null);
    if (!stored) {
      json(res, 404, { error: 'No context found for this token' });
      return;
    }
    json(res, 200, stored);
    return;
  }

  const owner = readOwner(mapping.ownerId);
  const requestedProfile = url.searchParams.get('profile');
  if (requestedProfile) {
    const ctx = owner.contexts[requestedProfile];
    if (!ctx) {
      json(res, 404, { error: `Profile "${requestedProfile}" not found`, available: Object.keys(owner.contexts) });
      return;
    }
    json(res, 200, { context: ctx, profileId: requestedProfile, profiles: owner.profiles, updatedAt: owner.updatedAt });
    return;
  }
  const defaultKey = owner.contexts.default ? 'default' : Object.keys(owner.contexts)[0];
  if (!defaultKey) {
    json(res, 404, { error: 'No context found for this token' });
    return;
  }
  json(res, 200, { context: owner.contexts[defaultKey] || '', profileId: defaultKey, profiles: owner.profiles, updatedAt: owner.updatedAt });
}

async function handleDeleteContext(req, res, tokenHash) {
  let data = {};
  try {
    const body = await readBody(req, 4096);
    data = body ? JSON.parse(body) : {};
  } catch {
    json(res, 400, { error: 'Invalid JSON' });
    return;
  }
  const tokenMap = readTokenMap();
  const mapping = tokenMap[tokenHash];
  if (!mapping?.ownerId) {
    json(res, 200, { ok: true, deleted: false });
    return;
  }
  const proof = verifyOwnerSignature({
    ownerId: data.ownerId,
    timestamp: Number(data.timestamp),
    signature: data.signature,
    tokenHash,
    profileId: data.profileId || 'default',
    context: data.context || '',
  });
  // Delete signs an empty context for a default profile. Keep failure closed.
  if (!proof.ok || proof.ownerId !== mapping.ownerId) {
    json(res, proof.status || 401, { error: proof.error || 'unauthorized' });
    return;
  }
  const owner = readOwner(mapping.ownerId);
  owner.tokens = owner.tokens.filter(t => t !== tokenHash);
  delete tokenMap[tokenHash];
  if (owner.tokens.length === 0) {
    try { rmSync(ownerPath(mapping.ownerId), { force: true }); } catch {}
  } else {
    writeOwner(mapping.ownerId, owner);
  }
  writeTokenMap(tokenMap);
  json(res, 200, { ok: true, deleted: true });
}

const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/health') {
    json(res, 200, { status: 'ok' });
    return;
  }

  const token = authToken(req);
  if (!token) {
    json(res, 401, { error: 'Missing or invalid token' });
    return;
  }
  const tokenHash = sha256Hex(token);

  if (req.method === 'POST' && url.pathname === '/api/context') {
    void handlePostContext(req, res, token, tokenHash);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/context') {
    handleGetContext(req, res, token, tokenHash, url);
    return;
  }

  if (req.method === 'DELETE' && url.pathname === '/api/context') {
    void handleDeleteContext(req, res, tokenHash);
    return;
  }

  json(res, 404, { error: 'Not found' });
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(PORT, BIND, () => {
    console.log(`Context gateway running on ${BIND}:${PORT}`);
  });
}

export {
  decodeOwnerId,
  server,
  sha256Hex,
  verifyOwnerSignature,
};
