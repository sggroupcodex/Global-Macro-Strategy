import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
process.env.GMS_CF_ACCOUNT_ID = '0'.repeat(32); // Synthetic test account; no network calls.
const {CONNECTION, MAX_BLOB, canonical, sha256, makeBlob, decodeBlob, blobKey, objectPath, readCurrentState, nextStateReads, prepareRequest, prepareAppend, verifyReceipt, recoveryMessage, reconcileRequests, readAsset, codeRefFromState, verifyCodeBundle, restoreCodeBundle, readSavedObject, prepareFinanceData, hydrateFinanceRuntime} = await import('../scripts/shared-r2-client.mjs');

const hash = n => n.repeat(64);
function record(id, kind = 'owner_instruction') { return {id, kind, reportedDate: '2026-11-02', title: '引継ぎ', summary: '要点', status: 'reported', source: '/records/test.json', data: {holdings: [{quantity: 2}], policies: ['約定を推測しない']}}; }
function event(input, sequence, previousHash) { const p = {...input, sequence, previousHash, recordedAt: '2026-11-02T00:00:00.000Z'}; return {...p, hash: sha256(canonical(p))}; }
function fixture() {
  const objects = new Map();
  const put = value => { const b = makeBlob(value); objects.set(blobKey(b.sha256), b); return b.sha256; };
  const cp = event(record('BASE-1', 'checkpoint'), 1, null), cpBlob = put(cp);
  const ref = (e, blobHash = put(e)) => ({id: e.id, sequence: e.sequence, eventHash: e.hash, blobHash});
  const root = {schema: 'gms-ledger-root-v1', ledgerHead: cp.hash, eventCount: 1, sourceCount: 3, idIndexHash: hash('a'), checkpoint: ref(cp, cpBlob), latestHandoff: null, lastEvent: null, archive: {manifestHash: hash('b'), verificationHash: hash('c')}, bootstrapFingerprint: hash('d'), previousRoot: null, artifactManifestHash: hash('b'), artifactManifestLedgerHead: cp.hash, createdAt: '2026-11-02T00:00:00.000Z'};
  let current = root, rootHash = put(root);
  const activate = (r, h = put(r)) => { current = r; rootHash = h; objects.set(CONNECTION.prefix + 'active.json', {schema: 'gms-ledger-active-v1', rootHash: h}); return h; };
  activate(root, rootHash);
  const append = (input, {wrongPrevious = false} = {}) => {
    const e = event(input, current.eventCount + 1, wrongPrevious ? hash('f') : current.ledgerHead), reference = ref(e);
    const next = {...current, eventCount: e.sequence, ledgerHead: e.hash, previousRoot: rootHash, lastEvent: reference, checkpoint: e.kind === 'checkpoint' ? reference : current.checkpoint, latestHandoff: e.kind === 'task_handoff' ? reference : current.latestHandoff};
    activate(next); return e;
  };
  return {objects, put, cp, root, ref, append, activate, get current() { return current; }, get rootHash() { return rootHash; }, get: async key => { if (!objects.has(key)) throw Error('MISSING ' + key); return objects.get(key); }};
}
function receipt(plan, status, result, extra = {}) {
  const p = {schema: 'gms-ledger-receipt-v1', requestHash: plan.requestHash, requestId: plan.requestId, actor: 'cloudflare-authorized-r2-queue-producer', claimedClient: 'claude-code', status, etag: null, result, processedAt: '2026-11-02T00:00:01.000Z', ...extra};
  return {...p, receiptHash: sha256(canonical(p))};
}

test('binary Japanese/zero bytes and maximum-size blobs roundtrip; tamper and noncanonical base64 reject', () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from('日本語\u0000引継ぎ'), Buffer.alloc(MAX_BLOB, 0xff)]) {
    const wrapped = makeBlob(bytes); assert.deepEqual(decodeBlob(wrapped, wrapped.sha256), bytes);
  }
  assert.throws(() => makeBlob(Buffer.alloc(MAX_BLOB + 1)), /BLOB_LIMIT/);
  const b = makeBlob('a');
  assert.throws(() => decodeBlob({...b, data: 'YQ!!'}, b.sha256), /BLOB_HASH/);
  assert.throws(() => decodeBlob({...b, data: 'Yg=='}, b.sha256), /BLOB_HASH/);
  assert.throws(() => decodeBlob({...b, bytes: 2}, b.sha256), /BLOB_HASH/);
});

test('request bytes are canonical and rawBody preserves inbox hash through JSON transport', () => {
  const first = prepareRequest({requestId: 'OP-1', method: 'POST', path: '/v1/events', headers: {'if-match': 'etag-1'}, body: {record: record('OP-RECORD')}, claimedClient: 'codex'});
  const second = prepareRequest({body: {record: record('OP-RECORD')}, path: '/v1/events', method: 'POST', claimedClient: 'codex', headers: {'if-match': 'etag-1'}, requestId: 'OP-1'});
  assert.equal(first.requestHash, second.requestHash); assert.equal(first.upload.body, first.serialized); assert.equal(first.upload.rawBody, true);
  assert.equal(sha256(first.upload.body), first.requestHash); assert.equal(first.status, 'prepared_not_submitted');
  assert.deepEqual(recoveryMessage(first), {requestKey: first.key, sha256: first.requestHash});
  assert.throws(() => prepareRequest({headers: {authorization: 'secret'}}), /REQUEST_HEADERS/);
  assert.throws(() => prepareRequest({method: 'POST', path: '/v1/events', body: {record: record('X-1')}}), /ETAG_REQUIRED/);
  assert.throws(() => objectPath('gms-shared-v1/../active.json'), /OBJECT_KEY/);
  assert.notEqual(prepareRequest({}).requestHash, prepareRequest({}).requestHash, 'fresh reads receive distinct request IDs rather than a cached receipt');
});

test('inbox page recovery preserves pending write identity and does not swallow transport failures', async () => {
  const plan = prepareRequest({requestId: 'PENDING-1', method: 'POST', path: '/v1/events', headers: {'if-match': 'etag-1'}, body: {record: record('PENDING-EVENT')}});
  const map = {[plan.key]: JSON.parse(plan.serialized), [plan.receiptKey]: null};
  const result = await reconcileRequests(async key => map[key], [plan.key]);
  assert.equal(result.globalCoverageClaimed, false); assert.equal(result.results[0].state, 'pending'); assert.equal(result.results[0].plan.requestHash, plan.requestHash); assert.equal(result.results[0].mayMutateLedger, true);
  await assert.rejects(reconcileRequests(async () => { throw Error('AUTH_FAILED'); }, [plan.key]), /AUTH_FAILED/);
  const changed = {...map[plan.key], claimedClient: 'modified'};
  await assert.rejects(reconcileRequests(async () => changed, [plan.key]), /NONCANONICAL_REQUEST_REQUIRES_ORIGINAL_BYTES/);
});

test('current state includes every change after the checkpoint, including handoff and artifact-only roots', async () => {
  const f = fixture(); const handoff = f.append(record('HANDOFF-2', 'task_handoff')), newer = f.append(record('OWNER-3'));
  f.activate({...f.current, previousRoot: f.rootHash, artifactManifestHash: hash('e'), artifactManifestLedgerHead: f.current.ledgerHead});
  const result = await readCurrentState(f.get);
  assert.deepEqual(result.changes.map(x => x.id), [handoff.id, newer.id]);
  assert.equal(result.handoff.id, handoff.id); assert.equal(result.checkpoint.id, f.cp.id); assert.equal(result.changeReviewRequired, true); assert.equal(result.artifactManifestCurrent, true);
});

test('a checkpoint does not silently make an older derived artifact manifest current', async () => {
  const f = fixture(); const newCheckpoint = f.append(record('CHECKPOINT-2', 'checkpoint'));
  const state = await readCurrentState(f.get);
  assert.equal(state.checkpoint.id, newCheckpoint.id); assert.equal(state.checkpointCoversHead, true); assert.equal(state.changes.length, 0); assert.equal(state.artifactManifestCurrent, false);
});

test('missing bytes, corrupt wrappers, and a self-hashed broken event chain fail closed', async () => {
  const f = fixture(); f.append(record('BAD-2'), {wrongPrevious: true});
  await assert.rejects(readCurrentState(f.get), /ROOT_EVENT_CHAIN/);
  const g = fixture(), key = blobKey(g.rootHash), wrapped = g.objects.get(key);
  g.objects.set(key, {...wrapped, data: Buffer.from('tampered').toString('base64')});
  await assert.rejects(readCurrentState(g.get), /BLOB_SCHEMA|BLOB_HASH/);
});

test('active pointer change during a read retries rather than mixing generations', async () => {
  const f = fixture(); let reads = 0;
  const get = async key => {
    if (key === CONNECTION.prefix + 'active.json' && ++reads === 2) f.append(record('NEW-CHECKPOINT-2', 'checkpoint'));
    return f.get(key);
  };
  const state = await readCurrentState(get); assert.equal(state.root.eventCount, 2); assert.equal(state.checkpoint.id, 'NEW-CHECKPOINT-2'); assert.equal(reads, 4);
});

test('bounded readers reject long or corrupt history instead of returning a partial view', async () => {
  const f = fixture(); f.append(record('EVENT-2')); f.append(record('EVENT-3'));
  await assert.rejects(readCurrentState(f.get, {maxRoots: 1}), /ROOT_HISTORY_LIMIT/);
  await assert.rejects(readCurrentState(f.get, {maxBytes: 5}), /READ_BUDGET_EXCEEDED/);
});

test('MCP read plans require a separate final active check and detect a stale captured generation', async () => {
  const f = fixture(), input = {objects: {}};
  for (let tries = 0; tries < 10; tries++) {
    const plan = await nextStateReads(input);
    if (plan.nextReads[0]?.purpose === 'final-active-check') {
      assert.equal(plan.complete, false); input.finalActive = await f.get(plan.nextReads[0].key); break;
    }
    for (const read of plan.nextReads) input.objects[read.key] = await f.get(read.key);
  }
  const done = await nextStateReads(input); assert.equal(done.complete, true); assert.equal(done.remoteFreshnessVerified, false);
  f.append(record('CHANGED-2')); input.finalActive = await f.get(CONNECTION.prefix + 'active.json');
  const changed = await nextStateReads(input); assert.equal(changed.stateChanged, true); assert.equal(changed.complete, false);
});

test('receipt absence stays pending; valid 409/412 requires new read and review; tampering rejects', () => {
  const plan = prepareRequest({requestId: 'READ-1'});
  assert.equal(verifyReceipt(plan, null).state, 'pending');
  for (const status of [409, 412]) {
    const checked = verifyReceipt(plan, receipt(plan, status, {error: 'REVISION_CONFLICT'}));
    assert.equal(checked.committed, false); assert.equal(checked.requiresFreshReadAndReview, true);
  }
  const valid = receipt(plan, 200, {anything: true}); assert.equal(verifyReceipt(plan, valid).state, 'completed');
  assert.throws(() => verifyReceipt(plan, {...valid, status: 201}), /RECEIPT_HASH/);
  assert.throws(() => verifyReceipt({...plan, serialized: plan.serialized + ' '}, valid), /REQUEST_PLAN_HASH/);
});

test('append plans bind both ETag and ledger head; retry receipt must match the original record content', () => {
  const f = fixture(), input = record('APPEND-2'), state = {schema: 'gms-ledger-state-v1', rootHash: f.rootHash, root: f.current, etag: 'opaque-etag'};
  const plan = prepareAppend({record: input, state, requestId: 'WRITE-1', claimedClient: 'claude-code'}), e = f.append(input);
  const envelope = JSON.parse(plan.serialized); assert.equal(envelope.body.expectedLedgerHead, state.root.ledgerHead); assert.equal(envelope.headers['if-match'], 'opaque-etag');
  const entry = {...f.ref(e), idHash: sha256(e.id), contentHash: sha256(canonical(input))};
  const result = {appended: false, existing: true, event: entry, rootHash: f.rootHash, root: f.current};
  const checked = verifyReceipt(plan, receipt(plan, 200, result)); assert.equal(checked.state, 'committed'); assert.equal(checked.existing, true);
  assert.throws(() => verifyReceipt(plan, receipt(plan, 200, {...result, event: {...entry, contentHash: hash('e')}})), /APPEND_RECEIPT_MISMATCH/);
  assert.throws(() => prepareAppend({record: input, state: {...state, etag: null}}), /ETAG_REQUIRED/);
});

test('a matching legacy archived ID is recognized as already committed, never a new append', () => {
  const f = fixture(), {hash: eventHash, sequence, previousHash, recordedAt, ...input} = f.cp;
  f.append(record('AFTER-LEGACY-2'));
  const state = {schema: 'gms-ledger-state-v1', rootHash: f.rootHash, root: f.current, etag: 'current-etag'};
  const plan = prepareAppend({record: input, state, requestId: 'LEGACY-RETRY-1'});
  const entry = {id: input.id, idHash: sha256(input.id), contentHash: sha256(canonical(input)), eventHash, sequence, blobHash: null};
  const result = {appended: false, existing: true, event: entry, rootHash: state.rootHash, root: state.root};
  const checked = verifyReceipt(plan, receipt(plan, 200, result));
  assert.equal(checked.state, 'committed'); assert.equal(checked.existing, true); assert.equal(checked.newlyCommitted, false); assert.equal(checked.archived, true); assert.equal(checked.eventPayloadAvailable, false);
  assert.throws(() => verifyReceipt(plan, receipt(plan, 201, {...result, appended: true, existing: false})), /APPEND_RECEIPT_STATE/);
  assert.throws(() => verifyReceipt(plan, receipt(plan, 200, {...result, event: {...entry, contentHash: hash('e')}})), /APPEND_RECEIPT_MISMATCH/);
  assert.throws(() => verifyReceipt(plan, receipt(plan, 200, {...result, event: {...entry, sequence: 0}})), /APPEND_RECEIPT_STATE/);
});

test('asset tree resolves exact paths and verifies all ranges plus final file SHA', async () => {
  const f = fixture(), first = Buffer.from('ABC日本'), second = Buffer.from('語DEF'), a = f.put(first), b = f.put(second), bytes = Buffer.concat([first.subarray(3), second.subarray(0, 3)]);
  const file = {path: '/records/test.json', type: 'application/json', sha256: sha256(bytes), bytes: bytes.length, parts: [{blob: a, offset: 3, length: first.length - 3}, {blob: b, offset: 0, length: 3}]};
  const leaf = f.put({schema: 'gms-asset-tree-v1', kind: 'leaf', files: [file]});
  const branch = f.put({schema: 'gms-asset-tree-v1', kind: 'branch', children: [{sha256: leaf, first: file.path, last: file.path, count: 1, bytes: file.bytes}]});
  assert.deepEqual((await readAsset(f.get, branch, file.path)).bytes, bytes);
  assert.equal(await readAsset(f.get, branch, '/records/missing.json'), null);
  const badLeaf = f.put({schema: 'gms-asset-tree-v1', kind: 'leaf', files: [{...file, sha256: hash('a')}]});
  await assert.rejects(readAsset(f.get, badLeaf, file.path), /ASSET_HASH/);
  await assert.rejects(readAsset(f.get, leaf, file.path, {maxBytes: 1}), /ASSET_LIMIT/);
});


function codeFixture(files = {'AGENTS.md': 'Read live state before work.\n', 'scripts/check.mjs': 'export const check = true;\n'}) {
  const rows = Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([p, value]) => { const content = Buffer.from(value); return {path: p, sha256: sha256(content), bytes: content.length, data: content.toString('base64')}; });
  const bundle = makeBlob({schema: 'gms-private-code-bundle-v1', totalFileBytes: rows.reduce((s, x) => s + x.bytes, 0), files: rows});
  const descriptor = makeBlob({schema: 'gms-private-bootstrap-v1', codeBundleHash: bundle.sha256, codeBundleBytes: bundle.bytes, fileCount: rows.length, totalFileBytes: rows.reduce((s, x) => s + x.bytes, 0), entrypoints: [{name: 'check', path: 'scripts/check.mjs'}], requirements: {dataNotBundled: true, financialSnapshotMustMatchActiveLedgerHead: true}});
  return {bundle, descriptor, descriptorHash: descriptor.sha256};
}
function assetTree(f, values) {
  return f.put({schema: 'gms-asset-tree-v1', kind: 'leaf', files: Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([p, value]) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(canonical(value));
    return {path: p, type: 'application/octet-stream', sha256: sha256(bytes), bytes: bytes.length, parts: [{blob: f.put(bytes), offset: 0, length: bytes.length}]};
  })});
}
async function financeFixture({postCheckpointKind = null, codeRef = {descriptorHash: codeFixture().descriptorHash}} = {}) {
  const f = fixture();
  const cp = f.append({...record('FINANCE-CP-2', 'checkpoint'), data: {holdings: {}, sharedRuntime: {codeRef}, policies: {recordingPolicy: {conversationMode: 'key-points-only'}}}});
  if (postCheckpointKind) f.append(record('AFTER-CP-3', postCheckpointKind));
  const context = {...cp.data, schema: 'gms-memory-v1', asOf: cp.reportedDate, checkpointId: cp.id, ledgerHead: f.current.ledgerHead};
  const values = {context, brief: {ledgerHead: f.current.ledgerHead, checkpointId: cp.id}, financeProtocol: {schema: 'gms-finance-protocol-v1'}};
  const files = {'/knowledge/data-acquisition-policy.json': {schema: 'gms-data-acquisition-policy-v1'}, '/knowledge/brokers.json': {entries: [{id: 'synthetic-broker'}]}}, refs = {};
  for (const [role, value] of Object.entries(values)) {
    const bytes = Buffer.from(canonical(value)), hash = sha256(bytes), p = '/memory/objects/' + hash + '.json';
    files[p] = bytes; refs[role] = {path: p, sha256: hash, bytes: bytes.length};
  }
  files['/memory/manifest.json'] = {ledgerHead: f.current.ledgerHead, events: f.current.eventCount, files: f.current.sourceCount, hybrid: {refs}};
  f.activate({...f.current, artifactManifestHash: assetTree(f, files), artifactManifestLedgerHead: f.current.ledgerHead});
  return {f, state: await readCurrentState(f.get), context, files};
}

test('private code bundle binds descriptor, sorted file hashes, entrypoints, and excludes operational paths', () => {
  const c = codeFixture(); assert.equal(verifyCodeBundle(c.descriptor, c.bundle, c.descriptorHash).files.length, 2);
  assert.throws(() => verifyCodeBundle(c.descriptor, makeBlob('tampered'), c.descriptorHash), /BLOB_SCHEMA/);
  for (const p of ['scripts/../../escape.mjs', 'dist/memory/secret.js', 'records/owner.md', 'scripts/.hidden.js']) {
    const bad = codeFixture({[p]: 'secret', 'scripts/check.mjs': 'ok'});
    assert.throws(() => verifyCodeBundle(bad.descriptor, bad.bundle, bad.descriptorHash), /CODE_FILE_SCHEMA/);
  }
  const b = JSON.parse(decodeBlob(c.bundle, c.bundle.sha256)); b.files[0].data = Buffer.from('x'.repeat(b.files[0].bytes)).toString('base64');
  const bundle = makeBlob(b), d = JSON.parse(decodeBlob(c.descriptor, c.descriptorHash));
  const descriptor = makeBlob({...d, codeBundleHash: bundle.sha256, codeBundleBytes: bundle.bytes});
  assert.throws(() => verifyCodeBundle(descriptor, bundle, descriptor.sha256), /CODE_FILE_HASH/);
});

test('private code restores only inside ignored content-addressed cache and rejects symlinks/conflicting bytes', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'gms-code-test-')), outside = await fs.mkdtemp(path.join(os.tmpdir(), 'gms-outside-')), c = codeFixture();
  try {
    const restored = await restoreCodeBundle(c.descriptor, c.bundle, c.descriptorHash, {workspaceRoot: workspace});
    assert.equal(restored.financialReady, false); assert.equal(restored.operationalDataRestored, false); assert.equal(path.basename(restored.runtimePath), c.bundle.sha256);
    await restoreCodeBundle(c.descriptor, c.bundle, c.descriptorHash, {workspaceRoot: workspace});
    await fs.writeFile(path.join(restored.runtimePath, 'AGENTS.md'), 'changed');
    await assert.rejects(restoreCodeBundle(c.descriptor, c.bundle, c.descriptorHash, {workspaceRoot: workspace}), /CODE_CACHE_CONFLICT/);
    await fs.rm(path.join(workspace, '.sites-runtime'), {recursive: true}); await fs.symlink(outside, path.join(workspace, '.sites-runtime'));
    await assert.rejects(restoreCodeBundle(c.descriptor, c.bundle, c.descriptorHash, {workspaceRoot: workspace}), /CACHE_SYMLINK/);
    assert.deepEqual(await fs.readdir(outside), []);
  } finally { await fs.rm(workspace, {recursive: true, force: true}); await fs.rm(outside, {recursive: true, force: true}); }
});

test('CDC hydration verifies compressed bytes, decoded chunks and whole object with bounds', async () => {
  const f = fixture(), bytes = Buffer.from(canonical({text: '日本語'.repeat(100)})), rawHash = sha256(bytes), packed = gzipSync(bytes), packedHash = sha256(packed);
  const ref = {path: '/memory/objects/' + rawHash + '.json', sha256: rawHash, bytes: bytes.length};
  const chunk = {path: '/memory/object-chunks/' + packedHash + '.gz', sha256: packedHash, bytes: packed.length, decodedSHA256: rawHash, decodedBytes: bytes.length};
  const recipePath = '/memory/object-recipes/' + rawHash + '.json';
  const recipe = {schema: 'gms-object-cdc-v1', sha256: rawHash, bytes: bytes.length, chunks: [chunk]};
  const tree = assetTree(f, {[recipePath]: recipe, [chunk.path]: packed}), config = {encoding: 'gzip-cdc', recipePrefix: '/memory/object-recipes/'};
  assert.deepEqual((await readSavedObject(f.get, tree, ref, config)).bytes, bytes);
  await assert.rejects(readSavedObject(f.get, tree, ref, config, {maxBytes: 1}), /SAVED_REFERENCE/);
  const corruptTree = assetTree(f, {[recipePath]: {...recipe, chunks: [{...chunk, decodedSHA256: hash('e')}]}, [chunk.path]: packed});
  await assert.rejects(readSavedObject(f.get, corruptTree, ref, config), /CHUNK_DECODED_HASH/);
  const bombTree = assetTree(f, {[recipePath]: {...recipe, chunks: [{...chunk, decodedBytes: 1}]}, [chunk.path]: packed});
  await assert.rejects(readSavedObject(f.get, bombTree, ref, config));
});

test('finance hydration binds manifest, checkpoint and all changes; stale artifacts or unreconciled changes stop it', async () => {
  const {f, state, context} = await financeFixture({postCheckpointKind: 'task_handoff'});
  const prepared = await prepareFinanceData(f.get, state); assert.deepEqual(JSON.parse(prepared.files.get('dist/memory/context.json')), context);
  assert.equal([...prepared.files.keys()].at(-1), 'dist/memory/manifest.json');
  const staleRoot = {...state.root, artifactManifestLedgerHead: hash('f')};
  await assert.rejects(prepareFinanceData(f.get, {...state, root: staleRoot, rootHash: sha256(canonical(staleRoot))}), /ARTIFACT_STALE/);
  await assert.rejects(prepareFinanceData(f.get, {...state, changes: []}), /FINANCE_CHANGE_CHAIN/);
  const changed = await financeFixture({postCheckpointKind: 'owner_instruction'});
  await assert.rejects(prepareFinanceData(changed.f.get, changed.state), /UNCHECKPOINTED_CHANGES_REQUIRE_RECONCILIATION/);
});

test('finance hydrate needs code restore and never certifies captured data as remotely fresh', async () => {
  const c = codeFixture(), workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'gms-finance-test-'));
  try {
    const {f, state} = await financeFixture(), restored = await restoreCodeBundle(c.descriptor, c.bundle, c.descriptorHash, {workspaceRoot: workspace});
    const result = await hydrateFinanceRuntime(f.get, state, restored.runtimePath);
    assert.equal(result.remoteFreshnessVerified, false); assert.equal(result.callerMustPerformFreshActiveRead, true);
    assert.equal(JSON.parse(await fs.readFile(path.join(restored.runtimePath, 'dist/memory/manifest.json'))).ledgerHead, state.root.ledgerHead);
    await assert.rejects(hydrateFinanceRuntime(f.get, state, workspace), /RUNTIME_CACHE_PATH/);
    await fs.rm(path.join(restored.runtimePath, '.code-restore.json'));
    await assert.rejects(hydrateFinanceRuntime(f.get, state, restored.runtimePath));
  } finally { await fs.rm(workspace, {recursive: true, force: true}); }
});


test('private code reference comes from verified current handoff or checkpoint and refuses a forged handoff', async () => {
  const f = fixture(), codeRef = {descriptorHash: hash('e')};
  f.append({...record('CP-2', 'checkpoint'), data: {sharedRuntime: {codeRef}}});
  const state = await readCurrentState(f.get);
  assert.equal(codeRefFromState(state).descriptorHash, codeRef.descriptorHash);
  assert.throws(() => codeRefFromState({...state, handoff: event({...record('FAKE-3', 'task_handoff'), data: {codeRef}}, 3, state.root.ledgerHead)}), /HANDOFF_REFERENCE/);
  f.append({...record('HANDOFF-3', 'task_handoff'), data: {codeRef: {descriptorHash: hash('f')}}});
  assert.equal(codeRefFromState(await readCurrentState(f.get)).descriptorHash, hash('f'));
});


test('finance hydration rejects an old codeRef, altered restore metadata and changed runtime source', async () => {
  const c = codeFixture(), workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'gms-code-binding-test-'));
  try {
    const restored = await restoreCodeBundle(c.descriptor, c.bundle, c.descriptorHash, {workspaceRoot: workspace});
    const newer = await financeFixture({codeRef: {descriptorHash: hash('e')}});
    await assert.rejects(hydrateFinanceRuntime(newer.f.get, newer.state, restored.runtimePath), /CODE_REFERENCE_STALE/);
    const {f, state} = await financeFixture();
    await fs.writeFile(path.join(restored.runtimePath, 'scripts/check.mjs'), 'export const unauthorized = true;');
    await assert.rejects(hydrateFinanceRuntime(f.get, state, restored.runtimePath), /RESTORED_CODE_CHANGED/);
    await fs.writeFile(path.join(restored.runtimePath, 'scripts/check.mjs'), Buffer.from(JSON.parse(decodeBlob(c.bundle, c.bundle.sha256)).files.find(x=>x.path==='scripts/check.mjs').data, 'base64'));
    await fs.writeFile(path.join(restored.runtimePath, '.code-descriptor.blob.json'), JSON.stringify(makeBlob({forged: true})));
    await assert.rejects(hydrateFinanceRuntime(f.get, state, restored.runtimePath), /BLOB_SCHEMA/);
  } finally { await fs.rm(workspace, {recursive: true, force: true}); }
});

test('a snapshot without broker hydration removes the prior optional broker cache', async () => {
  const c = codeFixture(), workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'gms-optional-data-test-'));
  try {
    const {f, state} = await financeFixture(), restored = await restoreCodeBundle(c.descriptor, c.bundle, c.descriptorHash, {workspaceRoot: workspace});
    await hydrateFinanceRuntime(f.get, state, restored.runtimePath, {includeBrokerKnowledge: true});
    const brokerPath = path.join(restored.runtimePath, 'dist/knowledge/brokers.json');
    assert.ok(await fs.stat(brokerPath));
    await hydrateFinanceRuntime(f.get, state, restored.runtimePath);
    await assert.rejects(fs.stat(brokerPath), {code: 'ENOENT'});
    assert.ok(await fs.stat(path.join(restored.runtimePath, 'dist/knowledge/data-acquisition-policy.json')));
  } finally { await fs.rm(workspace, {recursive: true, force: true}); }
});
