// Provider-neutral, transport-free client. No credentials or network fallback.
import {createHash, randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';

const configuredAccountId = process.env.GMS_CF_ACCOUNT_ID;
const configuredBucket = process.env.GMS_R2_BUCKET ?? 'global-macro-strategy-ledger';
const configuredPrefix = process.env.GMS_R2_PREFIX ?? 'gms-shared-v1/';
if (!/^[a-f0-9]{32}$/.test(configuredAccountId ?? '')) throw new Error('GMS_CF_ACCOUNT_ID_REQUIRED: discover the authorized account with Cloudflare OAuth; do not paste a secret.');
if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(configuredBucket)) throw new Error('GMS_R2_BUCKET_INVALID');
if (!/^[A-Za-z0-9][A-Za-z0-9/_-]{0,127}\/$/.test(configuredPrefix)) throw new Error('GMS_R2_PREFIX_INVALID');
export const CONNECTION = Object.freeze({accountId: configuredAccountId, bucket: configuredBucket, prefix: configuredPrefix});
export const MAX_BLOB = 4 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/;
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = code => { throw new Error(code); };
const hashOK = v => typeof v === 'string' && HASH.test(v);
const countOK = v => Number.isSafeInteger(v) && v >= 0;
const decodeText = bytes => new TextDecoder('utf-8', {fatal: true}).decode(bytes);

export function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (plain(value)) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  fail('INVALID_JSON');
}
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const blobKey = hash => { if (!hashOK(hash)) fail('INVALID_HASH'); return CONNECTION.prefix + 'blobs/' + hash; };
export const objectPath = key => {
  if (typeof key !== 'string' || !key.startsWith(CONNECTION.prefix) || key.includes('..') || /[\\\x00-\x20?#]/.test(key)) fail('OBJECT_KEY');
  return '/accounts/' + CONNECTION.accountId + '/r2/buckets/' + CONNECTION.bucket + '/objects/' + key.split('/').map(encodeURIComponent).join('/');
};

export function makeBlob(value) {
  const bytes = Buffer.isBuffer(value) || value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(typeof value === 'string' ? value : canonical(value));
  if (bytes.length > MAX_BLOB) fail('BLOB_LIMIT');
  return {schema: 'gms-blob-v1', encoding: 'base64', sha256: sha256(bytes), bytes: bytes.length, data: bytes.toString('base64')};
}
export function decodeBlob(wrapper, expectedHash) {
  if (!hashOK(expectedHash) || !plain(wrapper) || wrapper.schema !== 'gms-blob-v1' || wrapper.encoding !== 'base64' || wrapper.sha256 !== expectedHash || !countOK(wrapper.bytes) || wrapper.bytes > MAX_BLOB || typeof wrapper.data !== 'string' || wrapper.data.length !== Math.ceil(wrapper.bytes / 3) * 4) fail('BLOB_SCHEMA');
  const bytes = Buffer.from(wrapper.data, 'base64');
  if (bytes.length !== wrapper.bytes || bytes.toString('base64') !== wrapper.data || sha256(bytes) !== expectedHash) fail('BLOB_HASH');
  return bytes;
}
const decodeJSON = bytes => { try { return JSON.parse(decodeText(bytes)); } catch { fail('INVALID_JSON'); } };

function validateRef(ref, eventCount) {
  if (!plain(ref) || !ID.test(ref.id ?? '') || !hashOK(ref.blobHash) || !hashOK(ref.eventHash) || !Number.isSafeInteger(ref.sequence) || ref.sequence < 1 || ref.sequence > eventCount) fail('EVENT_REFERENCE');
}
export function validateRoot(root) {
  if (!plain(root) || root.schema !== 'gms-ledger-root-v1' || !hashOK(root.ledgerHead) || !countOK(root.eventCount) || root.eventCount < 1 || !countOK(root.sourceCount) || !hashOK(root.idIndexHash) || !hashOK(root.bootstrapFingerprint) || !(root.previousRoot === null || hashOK(root.previousRoot)) || !plain(root.archive) || !hashOK(root.archive.manifestHash) || !hashOK(root.archive.verificationHash)) fail('ROOT_SCHEMA');
  validateRef(root.checkpoint, root.eventCount);
  if (root.latestHandoff) validateRef(root.latestHandoff, root.eventCount);
  if (root.lastEvent) {
    validateRef(root.lastEvent, root.eventCount);
    if (root.lastEvent.eventHash !== root.ledgerHead || root.lastEvent.sequence !== root.eventCount) fail('ROOT_HEAD');
  }
  if (!hashOK(root.artifactManifestHash) || !hashOK(root.artifactManifestLedgerHead)) fail('ARTIFACT_REFERENCE');
  return root;
}
export function verifyEvent(event, ref) {
  if (!plain(event) || !ID.test(event.id ?? '') || !Number.isSafeInteger(event.sequence) || event.sequence < 1 || !hashOK(event.hash) || !(event.previousHash === null || hashOK(event.previousHash)) || typeof event.recordedAt !== 'string' || Number.isNaN(Date.parse(event.recordedAt))) fail('EVENT_SCHEMA');
  const {hash, ...payload} = event;
  if (sha256(canonical(payload)) !== hash) fail('EVENT_HASH');
  if (ref && (ref.id !== event.id || ref.sequence !== event.sequence || ref.eventHash !== hash)) fail('EVENT_REFERENCE');
  return event;
}
function loader(getObject, maxBytes = 32 * 1024 * 1024) {
  if (typeof getObject !== 'function') fail('TRANSPORT_REQUIRED');
  let total = 0; const cache = new Map();
  return async hash => {
    if (cache.has(hash)) return cache.get(hash);
    const bytes = decodeBlob(await getObject(blobKey(hash)), hash);
    total += bytes.length; if (total > maxBytes) fail('READ_BUDGET_EXCEEDED');
    cache.set(hash, bytes); return bytes;
  };
}
function validateActive(active) {
  if (!plain(active) || active.schema !== 'gms-ledger-active-v1' || !hashOK(active.rootHash)) fail('ACTIVE_SCHEMA');
  return active;
}

// Read both sides of the operation. Changed active pointers cause a retry,
// never a mixture of independently current snapshots.
export async function readCurrentState(getObject, {maxAttempts = 3, maxRoots = 2048, maxBytes = 32 * 1024 * 1024} = {}) {
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 8 || !Number.isSafeInteger(maxRoots) || maxRoots < 1 || maxRoots > 10000 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) fail('READ_LIMITS');
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const load = loader(getObject, maxBytes), active = validateActive(await getObject(CONNECTION.prefix + 'active.json'));
    const root = validateRoot(decodeJSON(await load(active.rootHash)));
    const checkpoint = verifyEvent(decodeJSON(await load(root.checkpoint.blobHash)), root.checkpoint);
    if (checkpoint.kind !== 'checkpoint' || !plain(checkpoint.data)) fail('CHECKPOINT_SCHEMA');
    const handoff = root.latestHandoff ? verifyEvent(decodeJSON(await load(root.latestHandoff.blobHash)), root.latestHandoff) : null;
    if (handoff && (handoff.kind !== 'task_handoff' || !plain(handoff.data))) fail('HANDOFF_SCHEMA');
    const changed = new Map(), seen = new Set();
    let cursor = active.rootHash, branch = root, visited = 0;
    while (branch.eventCount > checkpoint.sequence) {
      if (++visited > maxRoots || seen.has(cursor)) fail('ROOT_HISTORY_LIMIT');
      seen.add(cursor);
      if (!branch.lastEvent || !branch.previousRoot) fail('CHECKPOINT_HISTORY_MISSING');
      const event = verifyEvent(decodeJSON(await load(branch.lastEvent.blobHash)), branch.lastEvent);
      const old = changed.get(event.sequence);
      if (old && old.hash !== event.hash) fail('EVENT_SEQUENCE_CONFLICT');
      changed.set(event.sequence, event);
      const previousHash = branch.previousRoot, previous = validateRoot(decodeJSON(await load(previousHash)));
      if (previous.eventCount > branch.eventCount || previous.eventCount < checkpoint.sequence) fail('ROOT_HISTORY_ORDER');
      if (previous.eventCount === branch.eventCount ? previous.ledgerHead !== branch.ledgerHead : previous.eventCount !== branch.eventCount - 1 || previous.ledgerHead !== event.previousHash) fail('ROOT_EVENT_CHAIN');
      cursor = previousHash; branch = previous;
    }
    if (branch.ledgerHead !== checkpoint.hash) fail('CHECKPOINT_HISTORY_HEAD');
    const changes = [...changed.values()].sort((a, b) => a.sequence - b.sequence);
    let head = checkpoint.hash, sequence = checkpoint.sequence;
    for (const event of changes) {
      if (event.sequence !== sequence + 1 || event.previousHash !== head) fail('EVENT_CHAIN');
      head = event.hash; sequence = event.sequence;
    }
    if (sequence !== root.eventCount || head !== root.ledgerHead) fail('CHECKPOINT_HEAD');
    const after = validateActive(await getObject(CONNECTION.prefix + 'active.json'));
    if (after.rootHash !== active.rootHash) continue;
    return {schema: 'gms-client-current-state-v1', rootHash: active.rootHash, root, checkpoint, handoff, changes, checkpointCoversHead: checkpoint.sequence === root.eventCount, changeReviewRequired: changes.length !== 0, artifactManifestCurrent: !!root.artifactManifestHash && root.artifactManifestLedgerHead === root.ledgerHead, observedAt: new Date().toISOString(), claim: 'Internally verified at this read; refresh before each material decision or write.'};
  }
  fail('STATE_CHANGED_RETRY');
}

// An MCP client can execute these GET plans without an API token, then feed the
// raw JSON responses back. The final active read is deliberately a separate step.
export async function nextStateReads({objects = {}, finalActive} = {}) {
  if (!plain(objects)) fail('OBJECT_MAP');
  const missing = key => { const error = new Error('OBJECT_MISSING'); error.key = key; throw error; };
  const get = async key => Object.hasOwn(objects, key) ? objects[key] : missing(key);
  try {
    const result = await readCurrentState(get, {maxAttempts: 1});
    const key = CONNECTION.prefix + 'active.json';
    if (finalActive === undefined) return {complete: false, nextReads: [{purpose: 'final-active-check', key, request: {method: 'GET', path: objectPath(key)}}], frozenRootHash: result.rootHash};
    validateActive(finalActive);
    if (finalActive.rootHash !== result.rootHash) return {complete: false, stateChanged: true, restartWithActive: finalActive, nextReads: [], reason: 'Start a new read at this active pointer; retain only hash-verified immutable blobs.'};
    return {complete: true, state: result, remoteFreshnessVerified: false, claim: 'The caller must attest that finalActive came from a new live GET; timestamps and captured JSON cannot establish freshness alone.'};
  } catch (error) {
    if (!error.key) throw error;
    return {complete: false, nextReads: [{purpose: 'state-object', key: error.key, request: {method: 'GET', path: objectPath(error.key)}}]};
  }
}

function cleanEtag(value) {
  if (typeof value !== 'string' || !value || value === '*' || value.length > 256 || value.includes(',') || value.startsWith('W/') || /[\r\n]/.test(value)) fail('ETAG_REQUIRED');
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}
export function prepareRequest({requestId = 'REQ-' + randomUUID(), method = 'GET', path = '/v1/state', headers = {}, body, claimedClient = null}) {
  if (!ID.test(requestId) || !['GET', 'POST', 'PUT', 'HEAD'].includes(method) || typeof path !== 'string' || !/^\/v1\/[A-Za-z0-9/_.:?=&-]+$/.test(path) || path.includes('..') || path.includes('//') || path.length > 1024 || !plain(headers)) fail('REQUEST_SCHEMA');
  for (const [key, value] of Object.entries(headers)) if (!['if-match', 'if-none-match'].includes(key.toLowerCase()) || typeof value !== 'string' || value.length > 256 || /[\r\n]/.test(value)) fail('REQUEST_HEADERS');
  if (['GET', 'HEAD'].includes(method) && body !== undefined) fail('REQUEST_BODY');
  if (method === 'POST' && ['/v1/events', '/v1/artifacts'].includes(path)) cleanEtag(headers['if-match'] ?? headers['If-Match']);
  if (!(claimedClient === null || typeof claimedClient === 'string' && claimedClient.length <= 128)) fail('CLIENT_LABEL');
  const envelope = {schema: 'gms-ledger-request-v1', requestId, method, path, headers, ...(body === undefined ? {} : {body}), claimedClient};
  const serialized = canonical(envelope), size = Buffer.byteLength(serialized);
  if (size > 6 * 1024 * 1024) fail('REQUEST_LIMIT');
  const requestHash = sha256(serialized), key = CONNECTION.prefix + 'inbox/' + requestHash + '.json';
  return {schema: 'gms-client-request-plan-v1', requestHash, requestId, key, receiptKey: CONNECTION.prefix + 'receipts/' + requestHash + '.json', serialized, upload: {method: 'PUT', path: objectPath(key), body: serialized, rawBody: true, contentType: 'application/json'}, status: 'prepared_not_submitted'};
}
function verifyPlan(plan) {
  if (!plain(plan) || plan.schema !== 'gms-client-request-plan-v1' || typeof plan.serialized !== 'string' || sha256(plan.serialized) !== plan.requestHash || plan.key !== CONNECTION.prefix + 'inbox/' + plan.requestHash + '.json' || plan.receiptKey !== CONNECTION.prefix + 'receipts/' + plan.requestHash + '.json') fail('REQUEST_PLAN_HASH');
  const request = JSON.parse(plan.serialized);
  if (request.requestId !== plan.requestId || request.schema !== 'gms-ledger-request-v1') fail('REQUEST_PLAN_SCHEMA');
  return request;
}
export function verifyReceipt(plan, receipt) {
  const request = verifyPlan(plan);
  if (receipt === null || receipt === undefined) return {state: 'pending', committed: false, requestHash: plan.requestHash, requestId: plan.requestId, reason: 'No durable receipt observed; do not infer execution or regenerate the operation ID.'};
  if (!plain(receipt) || receipt.schema !== 'gms-ledger-receipt-v1' || receipt.requestHash !== plan.requestHash || receipt.requestId !== plan.requestId || !hashOK(receipt.receiptHash) || !Number.isSafeInteger(receipt.status) || receipt.status < 100 || receipt.status > 599) fail('RECEIPT_SCHEMA');
  const {receiptHash, ...payload} = receipt;
  if (sha256(canonical(payload)) !== receiptHash) fail('RECEIPT_HASH');
  if (receipt.status === 409 || receipt.status === 412) return {state: 'conflict', committed: false, requiresFreshReadAndReview: true, requestHash: plan.requestHash, requestId: plan.requestId, error: receipt.result?.error ?? null, receipt};
  if (receipt.status < 200 || receipt.status >= 300) return {state: 'rejected', committed: false, requestHash: plan.requestHash, requestId: plan.requestId, error: receipt.result?.error ?? null, receipt};
  if (request.path === '/v1/events' && request.method === 'POST') {
    const result = receipt.result, entry = result?.event;
    if (!plain(result) || !((result.appended === true && result.existing === false) || (result.appended === false && result.existing === true)) || !plain(entry) || entry.id !== request.body?.record?.id || entry.idHash !== sha256(entry.id) || entry.contentHash !== sha256(canonical(request.body.record))) fail('APPEND_RECEIPT_MISMATCH');
    validateRoot(result.root);
    const archived = entry.blobHash === null;
    if (result.rootHash !== sha256(canonical(result.root)) || !hashOK(entry.eventHash) || !Number.isSafeInteger(entry.sequence) || entry.sequence < 1 || entry.sequence > result.root.eventCount || archived && result.existing !== true || !archived && !hashOK(entry.blobHash) || result.appended && entry.sequence !== result.root.eventCount || entry.sequence === result.root.eventCount && entry.eventHash !== result.root.ledgerHead) fail('APPEND_RECEIPT_STATE');
    return {state: 'committed', committed: true, newlyCommitted: result.appended === true, existing: result.existing === true, archived, eventPayloadAvailable: !archived, requestHash: plan.requestHash, requestId: plan.requestId, event: entry, rootHash: result.rootHash, receipt};
  }
  return {state: 'completed', committed: false, requestHash: plan.requestHash, requestId: plan.requestId, receipt};
}
export function prepareAppend({record, state, requestId, claimedClient}) {
  if (!plain(state) || state.schema !== 'gms-ledger-state-v1') fail('STATE_RECEIPT_REQUIRED');
  validateRoot(state.root);
  if (state.rootHash !== sha256(canonical(state.root))) fail('STATE_HASH');
  if (!plain(record) || !ID.test(record.id ?? '') || ['hash', 'sequence', 'previousHash', 'recordedAt'].some(k => k in record)) fail('RECORD_SCHEMA');
  return prepareRequest({requestId, claimedClient, method: 'POST', path: '/v1/events', headers: {'if-match': cleanEtag(state.etag)}, body: {record, expectedLedgerHead: state.root.ledgerHead}});
}
export function recoveryMessage(plan) {
  verifyPlan(plan);
  return {requestKey: plan.key, sha256: plan.requestHash};
}

// The caller paginates the R2 inbox list. Null means a confirmed object 404,
// never a swallowed authentication error, network failure, or timeout.
export async function reconcileRequests(getObject, inboxKeys, {maxRequests = 64} = {}) {
  if (typeof getObject !== 'function' || !Array.isArray(inboxKeys) || !Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 256 || inboxKeys.length > maxRequests || new Set(inboxKeys).size !== inboxKeys.length) fail('INBOX_PAGE_LIMIT');
  const results = [];
  for (const key of inboxKeys) {
    if (typeof key !== 'string' || !new RegExp('^' + CONNECTION.prefix + 'inbox/[a-f0-9]{64}\\.json$').test(key)) fail('INBOX_KEY');
    const envelope = await getObject(key);
    if (!plain(envelope) || envelope.schema !== 'gms-ledger-request-v1') fail('INBOX_REQUEST_MISSING');
    const plan = prepareRequest(envelope);
    if (plan.key !== key) fail('NONCANONICAL_REQUEST_REQUIRES_ORIGINAL_BYTES');
    const receipt = await getObject(plan.receiptKey);
    const checked = verifyReceipt(plan, receipt);
    results.push({requestHash: plan.requestHash, requestId: plan.requestId, method: envelope.method, path: envelope.path, mayMutateLedger: !['GET', 'HEAD'].includes(envelope.method), state: checked.state, committed: checked.committed, ...(checked.state === 'pending' ? {recovery: recoveryMessage(plan), plan} : {})});
  }
  return {schema: 'gms-request-page-reconciliation-v1', requestsChecked: inboxKeys.length, globalCoverageClaimed: false, results};
}

function validPath(path) { return typeof path === 'string' && path.startsWith('/') && !path.includes('..') && !path.includes('\\') && !/[\x00-\x20?#]/.test(path); }
export async function readAsset(getObject, treeHash, path, {maxBytes = 32 * 1024 * 1024} = {}) {
  if (!validPath(path) || !hashOK(treeHash) || !Number.isSafeInteger(maxBytes) || maxBytes < 1) fail('ASSET_REQUEST');
  const load = loader(getObject, maxBytes + 16 * MAX_BLOB); let cursor = treeHash, file = null;
  for (let depth = 0; depth < 16; depth++) {
    const node = decodeJSON(await load(cursor));
    if (!plain(node) || node.schema !== 'gms-asset-tree-v1' || !['leaf', 'branch'].includes(node.kind)) fail('ASSET_TREE_SCHEMA');
    const rows = node.kind === 'leaf' ? node.files : node.children;
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 64) fail('ASSET_TREE_FANOUT');
    let last = '';
    for (const row of rows) {
      const first = node.kind === 'leaf' ? row.path : row.first, end = node.kind === 'leaf' ? row.path : row.last;
      if (!validPath(first) || !validPath(end) || first > end || first <= last || !hashOK(row.sha256) || !countOK(row.bytes)) fail('ASSET_TREE_ORDER');
      last = end;
    }
    if (node.kind === 'leaf') { file = rows.find(row => row.path === path) ?? null; break; }
    const child = rows.find(row => row.first <= path && path <= row.last);
    if (!child) return null;
    cursor = child.sha256;
    if (depth === 15) fail('ASSET_TREE_DEPTH');
  }
  if (!file) return null;
  if (file.bytes > maxBytes || !Array.isArray(file.parts) || file.parts.length > 64 || typeof file.type !== 'string' || /[\r\n\x00]/.test(file.type)) fail('ASSET_LIMIT');
  const pieces = []; let size = 0;
  for (const part of file.parts) {
    if (!plain(part) || !hashOK(part.blob) || !countOK(part.offset) || !Number.isSafeInteger(part.length) || part.length < 1 || part.offset + part.length > MAX_BLOB) fail('ASSET_PART');
    const blob = await load(part.blob);
    if (part.offset + part.length > blob.length) fail('ASSET_PART_LENGTH');
    pieces.push(blob.subarray(part.offset, part.offset + part.length)); size += part.length;
    if (size > file.bytes) fail('ASSET_LENGTH');
  }
  const bytes = Buffer.concat(pieces);
  if (size !== file.bytes || sha256(bytes) !== file.sha256) fail('ASSET_HASH');
  return {file, bytes};
}

export function codeRefFromState(state) {
  if (!plain(state) || state.schema !== 'gms-client-current-state-v1') fail('VERIFIED_CURRENT_STATE_REQUIRED');
  validateRoot(state.root);
  if (state.rootHash !== sha256(canonical(state.root))) fail('STATE_HASH');
  verifyEvent(state.checkpoint, state.root.checkpoint);
  if (Boolean(state.handoff) !== Boolean(state.root.latestHandoff)) fail('HANDOFF_REFERENCE');
  if (state.handoff) verifyEvent(state.handoff, state.root.latestHandoff);
  const ref = state.handoff?.data?.codeRef ?? state.checkpoint?.data?.sharedRuntime?.codeRef;
  if (!plain(ref) || !hashOK(ref.descriptorHash)) fail('PRIVATE_CODE_REFERENCE_MISSING');
  return {descriptorHash: ref.descriptorHash, key: blobKey(ref.descriptorHash), request: {method: 'GET', path: objectPath(blobKey(ref.descriptorHash))}};
}

const codePath = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) && !value.split('/').some(p => !p || p === '.' || p === '..' || p.startsWith('.')) && !/(^|\/)(?:records|memory|knowledge|outputs|node_modules|backups)(\/|$)/.test(value) && (['AGENTS.md', 'README.md', 'package.json'].includes(value) || /^(scripts|dist|docs|tests)\/[A-Za-z0-9._/-]+\.(?:mjs|js|md|py)$/.test(value));
export function verifyCodeBundle(descriptorWrapper, bundleWrapper, descriptorHash) {
  const descriptor = decodeJSON(decodeBlob(descriptorWrapper, descriptorHash));
  if (descriptor.schema !== 'gms-private-bootstrap-v1' || !hashOK(descriptor.codeBundleHash) || !countOK(descriptor.codeBundleBytes) || !countOK(descriptor.fileCount) || descriptor.fileCount < 1 || !countOK(descriptor.totalFileBytes) || !Array.isArray(descriptor.entrypoints) || !plain(descriptor.requirements) || descriptor.requirements.dataNotBundled !== true || descriptor.requirements.financialSnapshotMustMatchActiveLedgerHead !== true) fail('BOOTSTRAP_DESCRIPTOR');
  const bytes = decodeBlob(bundleWrapper, descriptor.codeBundleHash), bundle = decodeJSON(bytes);
  if (bytes.length !== descriptor.codeBundleBytes || bundle.schema !== 'gms-private-code-bundle-v1' || !Array.isArray(bundle.files) || bundle.files.length !== descriptor.fileCount || bundle.files.length > 512 || bundle.totalFileBytes !== descriptor.totalFileBytes) fail('CODE_BUNDLE_SCHEMA');
  let total = 0, last = ''; const files = [];
  for (const file of bundle.files) {
    if (!plain(file) || !codePath(file.path) || file.path <= last || !hashOK(file.sha256) || !countOK(file.bytes) || typeof file.data !== 'string' || file.data.length !== Math.ceil(file.bytes / 3) * 4) fail('CODE_FILE_SCHEMA');
    const content = Buffer.from(file.data, 'base64');
    if (content.length !== file.bytes || content.toString('base64') !== file.data || sha256(content) !== file.sha256) fail('CODE_FILE_HASH');
    total += content.length; if (total > 8 * MAX_BLOB) fail('CODE_BUNDLE_LIMIT');
    last = file.path; files.push({...file, content});
  }
  if (total !== descriptor.totalFileBytes) fail('CODE_BUNDLE_SIZE');
  const names = new Set(files.map(file => file.path));
  for (const entry of descriptor.entrypoints) if (!plain(entry) || typeof entry.name !== 'string' || !codePath(entry.path) || !names.has(entry.path)) fail('CODE_ENTRYPOINT');
  return {descriptorHash, descriptor, bundleHash: descriptor.codeBundleHash, files};
}

async function ensureDirectory(parent, relative) {
  let current = parent;
  for (const component of relative.split('/').filter(Boolean)) {
    if (component === '.' || component === '..') fail('CACHE_PATH');
    current = path.join(current, component);
    try { await fs.mkdir(current, {mode: 0o700}); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('CACHE_SYMLINK');
  }
  return current;
}
async function writeCacheFile(root, relative, bytes, {immutable = true} = {}) {
  if (typeof relative !== 'string' || relative.startsWith('/') || relative.includes('\\') || relative.split('/').some(p => !p || p === '.' || p === '..')) fail('CACHE_PATH');
  const parent = path.dirname(relative), directory = parent === '.' ? root : await ensureDirectory(root, parent), target = path.join(directory, path.basename(relative));
  try {
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('CACHE_SYMLINK');
    if (immutable) { if (!(await fs.readFile(target)).equals(bytes)) fail('CODE_CACHE_CONFLICT'); return; }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temp = target + '.tmp-' + randomUUID();
  try { await fs.writeFile(temp, bytes, {flag: 'wx', mode: 0o600}); await fs.rename(temp, target); } finally { await fs.rm(temp, {force: true}); }
}
export async function restoreCodeBundle(descriptorWrapper, bundleWrapper, descriptorHash, {workspaceRoot = process.cwd()} = {}) {
  const verified = verifyCodeBundle(descriptorWrapper, bundleWrapper, descriptorHash), workspace = await fs.realpath(workspaceRoot);
  const runtimePath = await ensureDirectory(workspace, '.sites-runtime/private-runtime/' + verified.bundleHash);
  for (const file of verified.files) await writeCacheFile(runtimePath, file.path, file.content);
  await writeCacheFile(runtimePath, '.code-descriptor.blob.json', Buffer.from(canonical(descriptorWrapper)));
  await writeCacheFile(runtimePath, '.code-bundle.blob.json', Buffer.from(canonical(bundleWrapper)));
  const receipt = {schema: 'gms-code-restore-v1', descriptorHash, codeBundleHash: verified.bundleHash, fileCount: verified.files.length, totalFileBytes: verified.descriptor.totalFileBytes, runtimePath, restoredAt: new Date().toISOString(), operationalDataRestored: false, financialReady: false};
  await writeCacheFile(runtimePath, '.code-restore.json', Buffer.from(canonical(receipt)), {immutable: false});
  return receipt;
}

export async function readSavedObject(getObject, treeHash, ref, objectStorage, {maxBytes = 32 * 1024 * 1024} = {}) {
  if (!plain(ref) || !/^\/memory\/objects\/[a-f0-9]{64}\.json$/.test(ref.path ?? '') || !hashOK(ref.sha256) || !ref.path.endsWith(ref.sha256 + '.json') || !countOK(ref.bytes) || ref.bytes > maxBytes) fail('SAVED_REFERENCE');
  const original = await readAsset(getObject, treeHash, ref.path, {maxBytes});
  let bytes;
  if (original) bytes = original.bytes;
  else if (objectStorage?.encoding === 'gzip') {
    const packed = await readAsset(getObject, treeHash, ref.path + '.gz', {maxBytes});
    if (!packed) fail('SAVED_OBJECT_MISSING');
    bytes = gunzipSync(packed.bytes, {maxOutputLength: maxBytes});
  } else if (objectStorage?.encoding === 'gzip-cdc') {
    if (objectStorage.recipePrefix !== '/memory/object-recipes/' || !['gzip', undefined].includes(objectStorage.recipeEncoding)) fail('RECIPE_CONFIG');
    const recipePath = objectStorage.recipePrefix + ref.sha256 + '.json' + (objectStorage.recipeEncoding === 'gzip' ? '.gz' : '');
    const asset = await readAsset(getObject, treeHash, recipePath, {maxBytes: MAX_BLOB});
    if (!asset) fail('SAVED_RECIPE_MISSING');
    const recipeBytes = objectStorage.recipeEncoding === 'gzip' ? gunzipSync(asset.bytes, {maxOutputLength: MAX_BLOB}) : asset.bytes, recipe = decodeJSON(recipeBytes);
    if (recipe.schema !== 'gms-object-cdc-v1' || recipe.sha256 !== ref.sha256 || recipe.bytes !== ref.bytes || !Array.isArray(recipe.chunks) || recipe.chunks.length > 32768) fail('RECIPE_SCHEMA');
    const pieces = []; let total = 0;
    for (const chunk of recipe.chunks) {
      if (!/^\/memory\/object-chunks\/[a-f0-9]{64}\.gz$/.test(chunk.path ?? '') || !hashOK(chunk.sha256) || !chunk.path.endsWith(chunk.sha256 + '.gz') || !countOK(chunk.bytes) || !countOK(chunk.decodedBytes) || chunk.decodedBytes > MAX_BLOB || !hashOK(chunk.decodedSHA256)) fail('CHUNK_SCHEMA');
      const stored = await readAsset(getObject, treeHash, chunk.path, {maxBytes: MAX_BLOB});
      if (!stored || stored.bytes.length !== chunk.bytes || sha256(stored.bytes) !== chunk.sha256) fail('CHUNK_HASH');
      const piece = gunzipSync(stored.bytes, {maxOutputLength: Math.max(1, chunk.decodedBytes)});
      if (piece.length !== chunk.decodedBytes || sha256(piece) !== chunk.decodedSHA256) fail('CHUNK_DECODED_HASH');
      total += piece.length; if (total > ref.bytes) fail('OBJECT_SIZE'); pieces.push(piece);
    }
    bytes = Buffer.concat(pieces);
  } else fail('SAVED_OBJECT_MISSING');
  if (bytes.length !== ref.bytes || sha256(bytes) !== ref.sha256) fail('SAVED_OBJECT_HASH');
  return {bytes, value: decodeJSON(bytes)};
}

export async function prepareFinanceData(getObject, state, {includeEvents = false, includeBrokerKnowledge = false} = {}) {
  if (!plain(state) || state.schema !== 'gms-client-current-state-v1' || !plain(state.checkpoint) || !Array.isArray(state.changes)) fail('VERIFIED_CURRENT_STATE_REQUIRED');
  validateRoot(state.root);
  if (state.rootHash !== sha256(canonical(state.root)) || state.root.artifactManifestLedgerHead !== state.root.ledgerHead) fail('ARTIFACT_STALE');
  verifyEvent(state.checkpoint, state.root.checkpoint);
  let reviewedHead = state.checkpoint.hash, reviewedSequence = state.checkpoint.sequence;
  for (const event of state.changes) {
    verifyEvent(event);
    if (event.sequence !== reviewedSequence + 1 || event.previousHash !== reviewedHead) fail('FINANCE_CHANGE_CHAIN');
    reviewedHead = event.hash; reviewedSequence = event.sequence;
  }
  if (reviewedHead !== state.root.ledgerHead || reviewedSequence !== state.root.eventCount) fail('FINANCE_CHANGE_CHAIN');
  // Only an explicitly informational handoff may follow a checkpoint here.
  // Other uncheckpointed changes require reconciliation into current state.
  if (state.changes.some(event => event.kind !== 'task_handoff')) fail('UNCHECKPOINTED_CHANGES_REQUIRE_RECONCILIATION');
  const treeHash = state.root.artifactManifestHash, manifestAsset = await readAsset(getObject, treeHash, '/memory/manifest.json', {maxBytes: MAX_BLOB});
  if (!manifestAsset) fail('FINANCE_MANIFEST_MISSING');
  const manifest = decodeJSON(manifestAsset.bytes);
  if (manifest.ledgerHead !== state.root.ledgerHead || manifest.events !== state.root.eventCount || manifest.files !== state.root.sourceCount || !plain(manifest.hybrid?.refs)) fail('FINANCE_MANIFEST_STATE');
  const files = new Map(), values = {};
  for (const role of ['context', 'brief', 'financeProtocol', ...(includeEvents ? ['events'] : [])]) {
    const ref = manifest.hybrid.refs[role], object = await readSavedObject(getObject, treeHash, ref, manifest.objectStorage);
    files.set('dist' + ref.path, object.bytes); values[role] = object.value;
  }
  const expectedContext = {...state.checkpoint.data, schema: 'gms-memory-v1', asOf: state.checkpoint.reportedDate, checkpointId: state.checkpoint.id, ledgerHead: state.root.ledgerHead};
  if (canonical(values.context) !== canonical(expectedContext) || values.brief.ledgerHead !== state.root.ledgerHead || values.brief.checkpointId !== state.checkpoint.id || values.financeProtocol.schema !== 'gms-finance-protocol-v1') fail('FINANCE_CONTEXT_BINDING');
  if (values.context.policies?.recordingPolicy?.conversationMode !== 'key-points-only') fail('OWNER_RETENTION_REVIEW_REQUIRED');
  files.set('dist/memory/context.json', Buffer.from(JSON.stringify(values.context) + '\n'));
  files.set('dist/knowledge/finance-protocol.json', Buffer.from(JSON.stringify(values.financeProtocol) + '\n'));
  if (includeBrokerKnowledge) {
    const broker = await readAsset(getObject, treeHash, '/knowledge/brokers.json', {maxBytes: MAX_BLOB});
    if (!broker) fail('BROKER_KNOWLEDGE_MISSING'); files.set('dist/knowledge/brokers.json', broker.bytes);
  }
  {
    const policy = await readAsset(getObject, treeHash, '/knowledge/data-acquisition-policy.json', {maxBytes: MAX_BLOB});
    if (!policy) fail('ACQUISITION_POLICY_MISSING'); files.set('dist/knowledge/data-acquisition-policy.json', policy.bytes);
  }
  files.set('dist/memory/manifest.json', manifestAsset.bytes); // Activate the local derived manifest last.
  return {rootHash: state.rootHash, ledgerHead: state.root.ledgerHead, artifactManifestHash: treeHash, files, ownerPoliciesSource: 'verified checkpoint plus reviewed changes', operationalDataFromCodeBundle: false};
}
export async function hydrateFinanceRuntime(getObject, state, runtimePath, options = {}) {
  const target = path.resolve(runtimePath);
  if (!/\/\.sites-runtime\/private-runtime\/[a-f0-9]{64}$/.test(target.replaceAll('\\', '/'))) fail('RUNTIME_CACHE_PATH');
  const hash = path.basename(target);
  const root = await fs.realpath(target);
  if (root !== target || !(await fs.lstat(target)).isDirectory() || (await fs.lstat(target)).isSymbolicLink()) fail('CACHE_SYMLINK');
  const restored = decodeJSON(await fs.readFile(path.join(root, '.code-restore.json')));
  if (restored.schema !== 'gms-code-restore-v1' || restored.codeBundleHash !== hash) fail('CODE_RESTORE_REQUIRED');
  const codeRef = codeRefFromState(state);
  if (restored.descriptorHash !== codeRef.descriptorHash) fail('CODE_REFERENCE_STALE');
  const descriptorWrapper = decodeJSON(await fs.readFile(path.join(root, '.code-descriptor.blob.json'))), bundleWrapper = decodeJSON(await fs.readFile(path.join(root, '.code-bundle.blob.json')));
  const verified = verifyCodeBundle(descriptorWrapper, bundleWrapper, codeRef.descriptorHash);
  if (verified.bundleHash !== hash) fail('CODE_REFERENCE_BUNDLE');
  for (const file of verified.files) {
    const codeFile = path.join(root, file.path), resolved = await fs.realpath(codeFile);
    if (resolved !== codeFile || !(await fs.lstat(codeFile)).isFile()) fail('CACHE_SYMLINK');
    const bytes = await fs.readFile(codeFile);
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) fail('RESTORED_CODE_CHANGED');
  }
  const prepared = await prepareFinanceData(getObject, state, options);
  if (!options.includeBrokerKnowledge) {
    const knowledgeDir = await ensureDirectory(root, 'dist/knowledge');
    await fs.rm(path.join(knowledgeDir, 'brokers.json'), {force: true});
  }
  await ensureDirectory(root, 'dist/records');
  for (const [relative, bytes] of prepared.files) await writeCacheFile(root, relative, bytes, {immutable: false});
  const result = {schema: 'gms-finance-hydration-v1', codeBundleHash: hash, descriptorHash: restored.descriptorHash, rootHash: prepared.rootHash, ledgerHead: prepared.ledgerHead, artifactManifestHash: prepared.artifactManifestHash, fileCount: prepared.files.size, checkedAt: new Date().toISOString(), remoteFreshnessVerified: false, callerMustPerformFreshActiveRead: true, refreshBeforeNextDecision: true};
  await writeCacheFile(root, '.finance-hydration.json', Buffer.from(canonical(result)), {immutable: false});
  return result;
}

async function stdinJSON() { const parts = []; let size = 0; for await (const part of process.stdin) { size += part.length; if (size > 64 * 1024 * 1024) fail('INPUT_LIMIT'); parts.push(part); } return JSON.parse(Buffer.concat(parts).toString('utf8')); }
async function main() {
  const command = process.argv[2] ?? 'connection';
  if (command === 'connection') return CONNECTION;
  const input = await stdinJSON();
  if (command === 'prepare-request') return prepareRequest(input);
  if (command === 'prepare-append') return prepareAppend(input);
  if (command === 'check-receipt') return verifyReceipt(input.plan, input.receipt);
  if (command === 'recovery-message') return recoveryMessage(input);
  if (command === 'make-blob') return makeBlob(input.value);
  if (command === 'check-blob') { const bytes = decodeBlob(input.wrapper, input.hash); return {sha256: input.hash, bytes: bytes.length, ...(input.parseJSON ? {value: decodeJSON(bytes)} : {})}; }
  if (command === 'plan-state-read') return nextStateReads(input);
  if (command === 'code-ref') return codeRefFromState(input);
  if (command === 'check-code-bundle') { const v = verifyCodeBundle(input.descriptorWrapper, input.bundleWrapper, input.descriptorHash); return {descriptorHash: v.descriptorHash, bundleHash: v.bundleHash, fileCount: v.files.length, descriptor: v.descriptor}; }
  if (command === 'restore-code-bundle') return restoreCodeBundle(input.descriptorWrapper, input.bundleWrapper, input.descriptorHash);
  if (command === 'plan-finance-data' || command === 'hydrate-captured-finance') {
    if (!plain(input.objects)) fail('OBJECT_MAP');
    const get = async key => { if (!Object.hasOwn(input.objects, key)) { const error = new Error('OBJECT_MISSING'); error.key = key; throw error; } return input.objects[key]; };
    try {
      if (command === 'hydrate-captured-finance') {
        if (!plain(input.finalActive) || input.finalActive.schema !== 'gms-ledger-active-v1' || input.finalActive.rootHash !== input.state?.rootHash) fail('FINAL_ACTIVE_CHECK_REQUIRED');
        return await hydrateFinanceRuntime(get, input.state, input.runtimePath, input.options);
      }
      const prepared = await prepareFinanceData(get, input.state, input.options);
      return {complete: true, rootHash: prepared.rootHash, ledgerHead: prepared.ledgerHead, files: [...prepared.files].map(([path, bytes]) => ({path, bytes: bytes.length, sha256: sha256(bytes)})), requiresNewFinalActiveRead: true};
    } catch (error) { if (!error.key) throw error; return {complete: false, nextReads: [{key: error.key, request: {method: 'GET', path: objectPath(error.key)}}]}; }
  }
  if (command === 'reconcile-captured-requests') {
    if (!plain(input.objects)) fail('OBJECT_MAP');
    return reconcileRequests(async key => { if (!Object.hasOwn(input.objects, key)) fail('OBJECT_MISSING'); return input.objects[key]; }, input.keys, input.options);
  }
  // Captured transport objects only. This validates consistency, not remote
  // freshness; online callers must use readCurrentState with live GETs.
  if (command === 'inspect-captured-state') {
    if (!plain(input.objects)) fail('OBJECT_MAP');
    const result = await readCurrentState(async key => { if (!Object.hasOwn(input.objects, key)) fail('OBJECT_MISSING'); return input.objects[key]; });
    return {...result, remoteFreshnessVerified: false, claim: 'Captured input is internally consistent; a new live read is required before use.'};
  }
  if (command === 'read-captured-saved-object') {
    if (!plain(input.objects)) fail('OBJECT_MAP');
    try {
      const result = await readSavedObject(async key => { if (!Object.hasOwn(input.objects, key)) { const error = new Error('OBJECT_MISSING'); error.key = key; throw error; } return input.objects[key]; }, input.treeHash, input.ref, input.objectStorage, input.options);
      return {complete: true, sha256: input.ref.sha256, bytes: result.bytes.length, encoding: 'base64', data: result.bytes.toString('base64')};
    } catch (error) { if (!error.key) throw error; return {complete: false, nextReads: [{key: error.key, request: {method: 'GET', path: objectPath(error.key)}}]}; }
  }
  if (command === 'read-captured-asset') {
    if (!plain(input.objects)) fail('OBJECT_MAP');
    const asset = await readAsset(async key => { if (!Object.hasOwn(input.objects, key)) fail('OBJECT_MISSING'); return input.objects[key]; }, input.treeHash, input.path, input.options);
    return asset ? {file: asset.file, encoding: 'base64', data: asset.bytes.toString('base64')} : null;
  }
  fail('COMMAND: connection | prepare-request | prepare-append | check-receipt | recovery-message | make-blob | check-blob | plan-state-read | reconcile-captured-requests | inspect-captured-state | read-captured-asset | read-captured-saved-object | code-ref | check-code-bundle | restore-code-bundle | plan-finance-data | hydrate-captured-finance');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
