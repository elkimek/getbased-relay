import { createServer, request as httpRequest } from 'node:http';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DATA_DIR = process.env.CONTEXT_DATA_DIR || '/opt/context-gateway/data';
const VERIFY_URL = process.env.CONTEXT_VERIFY_URL || 'http://127.0.0.1:4004/verify-agent-context';
const VERIFY_SOCKET = process.env.CONTEXT_VERIFIER_SOCKET || '';
const VERIFY_TOKEN = process.env.CONTEXT_VERIFIER_TOKEN || '';
const PORT = Number(process.env.CONTEXT_PORT || 4001);
const BIND = process.env.CONTEXT_BIND || '127.0.0.1';
const MAX_CONTEXT_BYTES = Number(process.env.AGENT_CONTEXT_MAX_PROFILE_BYTES || 512 * 1024);
const OWNER_QUOTA_BYTES = Number(process.env.AGENT_CONTEXT_OWNER_QUOTA_BYTES || 5 * 1024 * 1024);
const MAX_PROFILES_PER_OWNER = Number(process.env.AGENT_CONTEXT_MAX_PROFILES || 20);
const MAX_TOKENS_PER_OWNER = Number(process.env.AGENT_CONTEXT_MAX_TOKENS || 3);
const MAX_PROPOSAL_CIPHERTEXT_BYTES = Number(process.env.AGENT_PROPOSAL_MAX_CIPHERTEXT_BYTES || 64 * 1024);
const MAX_PENDING_PROPOSALS_PER_TOKEN = Number(process.env.AGENT_PROPOSAL_MAX_PENDING || 20);
const configuredMaxTrackedProposals = Number(process.env.AGENT_PROPOSAL_MAX_TRACKED || 256);
const MAX_TRACKED_PROPOSALS_PER_TOKEN = Number.isSafeInteger(configuredMaxTrackedProposals)
  && configuredMaxTrackedProposals > 0 ? configuredMaxTrackedProposals : 256;
const PROPOSAL_RECEIPT_BYTES = Buffer.byteLength(JSON.stringify({
  proposalId: `proposal_${'A'.repeat(24)}`,
  tokenHash: '0'.repeat(64),
  acknowledgedAt: '2000-01-01T00:00:00.000Z',
}), 'utf8');
const OWNER_TRACKED_PROPOSAL_BUDGET_BYTES = Math.max(
  0,
  OWNER_QUOTA_BYTES - Math.min(MAX_CONTEXT_BYTES, OWNER_QUOTA_BYTES),
);
const MAX_TRACKED_PROPOSALS_PER_OWNER = Math.floor(
  OWNER_TRACKED_PROPOSAL_BUDGET_BYTES / PROPOSAL_RECEIPT_BYTES,
);
const PROPOSAL_RETENTION_MS = Number(process.env.AGENT_PROPOSAL_RETENTION_MS || 24 * 60 * 60 * 1000);
const TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;
const RATE_LIMIT_PER_MINUTE = Number(process.env.CONTEXT_RATE_LIMIT_PER_MINUTE || 300);
const CLIENT_IP_HEADER = /^[a-z0-9-]+$/i.test(process.env.CONTEXT_CLIENT_IP_HEADER || '')
  ? process.env.CONTEXT_CLIENT_IP_HEADER.toLowerCase()
  : '';
const rateBuckets = new Map();

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
    if (!Array.isArray(parsed.proposals)) parsed.proposals = [];
    if (!Array.isArray(parsed.proposalReceipts)) parsed.proposalReceipts = [];
    return parsed;
  }
  return {
    ownerId,
    contexts: {},
    profiles: null,
    tokens: [],
    proposals: [],
    proposalReceipts: [],
    updatedAt: null,
  };
}

function writeOwner(ownerId, owner) {
  atomicWriteJson(ownerPath(ownerId), owner);
}

function contextBytes(contexts) {
  return Object.values(contexts || {}).reduce((n, value) => n + Buffer.byteLength(String(value || ''), 'utf8'), 0);
}

function proposalBytes(proposals) {
  return (proposals || []).reduce(
    (n, proposal) => n + Buffer.byteLength(JSON.stringify(proposal || {}), 'utf8'),
    0,
  );
}

function ownerStorageBytes(contexts, proposals, proposalReceipts = []) {
  return contextBytes(contexts) + proposalBytes(proposals) + proposalBytes(proposalReceipts);
}

function isStrictBase64(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  try {
    return Buffer.from(value, 'base64').toString('base64') === value;
  } catch {
    return false;
  }
}

function proposalIdFromIv(iv) {
  return `proposal_${createHash('sha256').update(iv).digest('base64url').slice(0, 24)}`;
}

function ownerContextKeyIds(owner) {
  const keyIds = new Set();
  for (const serialized of Object.values(owner?.contexts || {})) {
    try {
      const parsed = JSON.parse(String(serialized || ''));
      const keyId = parsed?.encryptedContext?.keyId;
      if (typeof keyId === 'string' && /^[A-Za-z0-9_-]{16}$/.test(keyId)) keyIds.add(keyId);
    } catch {}
  }
  return keyIds;
}

function normalizeProposalEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const allowed = ['version', 'alg', 'keyDerivation', 'keyId', 'proposalId', 'iv', 'ciphertext'];
  const keys = Object.keys(value);
  if (keys.length !== allowed.length || keys.some(key => !allowed.includes(key))) return null;
  if (value.version !== 1 || value.alg !== 'AES-256-GCM' || value.keyDerivation !== 'raw-256-bit-key') return null;
  if (typeof value.keyId !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(value.keyId)) return null;
  if (typeof value.proposalId !== 'string' || !/^proposal_[A-Za-z0-9_-]{24}$/.test(value.proposalId)) return null;
  if (!isStrictBase64(value.iv)) return null;
  const iv = Buffer.from(value.iv, 'base64');
  if (iv.length !== 12 || value.proposalId !== proposalIdFromIv(iv)) return null;
  if (!isStrictBase64(value.ciphertext)) return null;
  const ciphertextBytes = Buffer.from(value.ciphertext, 'base64').length;
  if (ciphertextBytes < 17 || ciphertextBytes > MAX_PROPOSAL_CIPHERTEXT_BYTES) return null;
  return {
    version: 1,
    alg: 'AES-256-GCM',
    keyDerivation: 'raw-256-bit-key',
    keyId: value.keyId,
    proposalId: value.proposalId,
    iv: value.iv,
    ciphertext: value.ciphertext,
  };
}

function pruneExpiredProposals(owner, now = Date.now()) {
  const previousProposals = owner.proposals.length;
  const previousReceipts = owner.proposalReceipts.length;
  owner.proposals = owner.proposals.filter(proposal => {
    const createdAt = Date.parse(proposal?.createdAt || '');
    return Number.isFinite(createdAt) && now - createdAt <= PROPOSAL_RETENTION_MS;
  });
  owner.proposalReceipts = owner.proposalReceipts.filter(receipt => {
    const acknowledgedAt = Date.parse(receipt?.acknowledgedAt || '');
    return Number.isFinite(acknowledgedAt) && now - acknowledgedAt <= PROPOSAL_RETENTION_MS;
  });
  return owner.proposals.length !== previousProposals
    || owner.proposalReceipts.length !== previousReceipts;
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

async function verifyOwnerSignature({ ownerId, timestamp, signature, tokenHash, profileId, context }) {
  const ownerBytes = decodeOwnerId(ownerId);
  if (!ownerBytes) return { ok: false, status: 400, error: 'invalid_owner_id' };
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > TIMESTAMP_WINDOW_MS) {
    return { ok: false, status: 401, error: 'timestamp_outside_window' };
  }
  const contextHash = sha256Hex(context);
  if (!VERIFY_TOKEN) {
    return { ok: false, status: 503, error: 'verification_unavailable' };
  }
  const payload = {
    ownerId,
    timestamp,
    signature,
    tokenHash,
    profileId: profileId || 'default',
    contextHash,
  };
  try {
    const status = VERIFY_SOCKET
      ? await verifyOverSocket(payload)
      : await verifyOverHttp(payload);
    if (status >= 200 && status < 300) return { ok: true, ownerId, contextHash };
    if (status === 401 || status === 400) {
      return { ok: false, status: 401, error: 'unauthorized' };
    }
  } catch {}
  return { ok: false, status: 503, error: 'verification_unavailable' };
}

async function verifyOverHttp(payload) {
  const response = await fetch(VERIFY_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${VERIFY_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  });
  return response.status;
}

function verifyOverSocket(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const request = httpRequest({
      socketPath: VERIFY_SOCKET,
      path: '/verify-agent-context',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${VERIFY_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode || 503));
    });
    request.setTimeout(5000, () => request.destroy(new Error('verification_timeout')));
    request.on('error', reject);
    request.end(body);
  });
}

function requestIp(req) {
  const peer = String(req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
  const supplied = CLIENT_IP_HEADER ? req.headers[CLIENT_IP_HEADER] : '';
  const candidate = Array.isArray(supplied) ? supplied[0] : String(supplied || '');
  return isIP(candidate.trim()) ? candidate.trim() : (isIP(peer) ? peer : 'unknown');
}

function rateCheck(req) {
  if (!Number.isFinite(RATE_LIMIT_PER_MINUTE) || RATE_LIMIT_PER_MINUTE <= 0) return true;
  const now = Date.now();
  const key = requestIp(req);
  let bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.startedAt >= 60_000) {
    bucket = { startedAt: now, count: 0 };
    rateBuckets.set(key, bucket);
  }
  bucket.count += 1;
  if (rateBuckets.size > 10_000) {
    for (const [candidate, value] of rateBuckets) {
      if (now - value.startedAt >= 60_000) rateBuckets.delete(candidate);
    }
    while (rateBuckets.size > 10_000) {
      rateBuckets.delete(rateBuckets.keys().next().value);
    }
  }
  return bucket.count <= RATE_LIMIT_PER_MINUTE;
}

function rejectRateLimited(res) {
  res.setHeader('Retry-After', '60');
  json(res, 429, { error: 'rate_limited' });
}

function addSecurityHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

function requireRateAllowance(req, res) {
  if (!rateCheck(req)) {
    rejectRateLimited(res);
    return false;
  }
  return true;
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

  const proof = await verifyOwnerSignature({
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
  pruneExpiredProposals(owner);
  const nextBytes = ownerStorageBytes(nextContexts, owner.proposals, owner.proposalReceipts);
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

async function handlePostProposal(req, res, tokenHash) {
  let data;
  try {
    const body = await readBody(req, Math.max(MAX_PROPOSAL_CIPHERTEXT_BYTES * 2, 32 * 1024));
    data = JSON.parse(body);
  } catch (e) {
    const tooLarge = e?.message === 'payload_too_large';
    json(res, tooLarge ? 413 : 400, { error: tooLarge ? 'proposal_too_large' : 'invalid_json' });
    return;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)
      || Object.keys(data).length !== 1 || !Object.hasOwn(data, 'envelope')) {
    json(res, 400, { error: 'invalid_proposal_envelope' });
    return;
  }
  const envelope = normalizeProposalEnvelope(data.envelope);
  if (!envelope) {
    json(res, 400, { error: 'invalid_proposal_envelope' });
    return;
  }

  const tokenMap = readTokenMap();
  const mapping = tokenMap[tokenHash];
  if (!mapping?.ownerId) {
    json(res, 404, { error: 'agent_access_not_registered' });
    return;
  }
  const owner = readOwner(mapping.ownerId);
  if (!ownerContextKeyIds(owner).has(envelope.keyId)) {
    json(res, 400, { error: 'invalid_proposal_envelope' });
    return;
  }
  pruneExpiredProposals(owner);
  const existing = owner.proposals.find(
    proposal => proposal.tokenHash === tokenHash && proposal.proposalId === envelope.proposalId,
  );
  if (existing) {
    const sameEnvelope = sha256Hex(JSON.stringify(existing.envelope)) === sha256Hex(JSON.stringify(envelope));
    if (!sameEnvelope) {
      json(res, 409, { error: 'proposal_id_conflict' });
      return;
    }
    json(res, 200, { ok: true, proposalId: envelope.proposalId, duplicate: true });
    return;
  }
  const acknowledged = owner.proposalReceipts.some(
    receipt => receipt.tokenHash === tokenHash && receipt.proposalId === envelope.proposalId,
  );
  if (acknowledged) {
    json(res, 200, { ok: true, proposalId: envelope.proposalId, duplicate: true });
    return;
  }
  const pendingForToken = owner.proposals.filter(proposal => proposal.tokenHash === tokenHash).length;
  if (pendingForToken >= MAX_PENDING_PROPOSALS_PER_TOKEN) {
    json(res, 409, { error: 'proposal_limit_exceeded', maxPending: MAX_PENDING_PROPOSALS_PER_TOKEN });
    return;
  }
  const receiptsForToken = owner.proposalReceipts.filter(receipt => receipt.tokenHash === tokenHash).length;
  if (pendingForToken + receiptsForToken >= MAX_TRACKED_PROPOSALS_PER_TOKEN) {
    json(res, 409, {
      error: 'proposal_retention_limit_exceeded',
      maxTracked: MAX_TRACKED_PROPOSALS_PER_TOKEN,
    });
    return;
  }
  const trackedForOwner = owner.proposals.length + owner.proposalReceipts.length;
  if (trackedForOwner >= MAX_TRACKED_PROPOSALS_PER_OWNER) {
    json(res, 409, {
      error: 'proposal_owner_retention_limit_exceeded',
      maxTrackedOwner: MAX_TRACKED_PROPOSALS_PER_OWNER,
    });
    return;
  }

  const createdAt = new Date().toISOString();
  const nextProposals = [
    ...owner.proposals,
    { proposalId: envelope.proposalId, tokenHash, envelope, createdAt },
  ];
  const nextBytes = ownerStorageBytes(owner.contexts, nextProposals, owner.proposalReceipts);
  if (nextBytes > OWNER_QUOTA_BYTES) {
    json(res, 413, { error: 'owner_quota_exceeded', ownerBytes: nextBytes, quotaBytes: OWNER_QUOTA_BYTES });
    return;
  }
  owner.proposals = nextProposals;
  owner.updatedAt = createdAt;
  owner.bytes = nextBytes;
  writeOwner(mapping.ownerId, owner);
  json(res, 201, { ok: true, proposalId: envelope.proposalId, duplicate: false });
}

function handleGetProposals(res, tokenHash) {
  const tokenMap = readTokenMap();
  const mapping = tokenMap[tokenHash];
  if (!mapping?.ownerId) {
    json(res, 404, { error: 'agent_access_not_registered' });
    return;
  }
  const owner = readOwner(mapping.ownerId);
  const pruned = pruneExpiredProposals(owner);
  if (pruned) {
    owner.bytes = ownerStorageBytes(owner.contexts, owner.proposals, owner.proposalReceipts);
    writeOwner(mapping.ownerId, owner);
  }
  const proposals = owner.proposals
    .filter(proposal => proposal.tokenHash === tokenHash)
    .map(({ proposalId, envelope, createdAt }) => ({ proposalId, envelope, createdAt }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  json(res, 200, { proposals });
}

function handleDeleteProposal(res, tokenHash, proposalId) {
  const tokenMap = readTokenMap();
  const mapping = tokenMap[tokenHash];
  if (!mapping?.ownerId) {
    json(res, 200, { ok: true, deleted: false });
    return;
  }
  const owner = readOwner(mapping.ownerId);
  pruneExpiredProposals(owner);
  const previous = owner.proposals.length;
  owner.proposals = owner.proposals.filter(
    proposal => !(proposal.tokenHash === tokenHash && proposal.proposalId === proposalId),
  );
  const deleted = owner.proposals.length !== previous;
  if (deleted) {
    owner.updatedAt = new Date().toISOString();
    if (!owner.proposalReceipts.some(
      receipt => receipt.tokenHash === tokenHash && receipt.proposalId === proposalId,
    )) {
      owner.proposalReceipts.push({ proposalId, tokenHash, acknowledgedAt: owner.updatedAt });
    }
    owner.bytes = ownerStorageBytes(owner.contexts, owner.proposals, owner.proposalReceipts);
    writeOwner(mapping.ownerId, owner);
  }
  json(res, 200, { ok: true, deleted });
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
  const proof = await verifyOwnerSignature({
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
  owner.proposals = owner.proposals.filter(proposal => proposal.tokenHash !== tokenHash);
  owner.proposalReceipts = owner.proposalReceipts.filter(receipt => receipt.tokenHash !== tokenHash);
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
  addSecurityHeaders(res);
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

  if (!requireRateAllowance(req, res)) return;

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

  if (req.method === 'POST' && url.pathname === '/api/agent-proposals') {
    void handlePostProposal(req, res, tokenHash);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/agent-proposals') {
    handleGetProposals(res, tokenHash);
    return;
  }

  const proposalDelete = url.pathname.match(/^\/api\/agent-proposals\/(proposal_[A-Za-z0-9_-]{6,112})$/);
  if (req.method === 'DELETE' && proposalDelete) {
    handleDeleteProposal(res, tokenHash, proposalDelete[1]);
    return;
  }

  if (req.method === 'DELETE' && url.pathname === '/api/context') {
    void handleDeleteContext(req, res, tokenHash);
    return;
  }

  json(res, 404, { error: 'Not found' });
});

server.headersTimeout = 5000;
server.requestTimeout = 10000;
server.keepAliveTimeout = 5000;
server.maxRequestsPerSocket = 100;

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
  requestIp,
};
