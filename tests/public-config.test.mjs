import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const client = fileURLToPath(new URL('../scripts/shared-r2-client.mjs', import.meta.url));

test('public checkout fails closed without the discovered account configuration', () => {
  const {GMS_CF_ACCOUNT_ID, ...env} = process.env;
  const result = spawnSync(process.execPath, [client, 'connection'], {env, encoding: 'utf8'});
  assert.notEqual(result.status, 0); assert.match(result.stderr, /GMS_CF_ACCOUNT_ID_REQUIRED/);
  assert.equal(result.stdout, '');
});

test('public client injects only validated nonsecret connection values', () => {
  const accountId = '1'.repeat(32);
  const result = spawnSync(process.execPath, [client, 'connection'], {env: {...process.env, GMS_CF_ACCOUNT_ID: accountId, GMS_R2_BUCKET: 'synthetic-ledger', GMS_R2_PREFIX: 'test-ledger/'}, encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {accountId, bucket: 'synthetic-ledger', prefix: 'test-ledger/'});
  const bad = spawnSync(process.execPath, [client, 'connection'], {env: {...process.env, GMS_CF_ACCOUNT_ID: accountId, GMS_R2_BUCKET: '../private'}, encoding: 'utf8'});
  assert.notEqual(bad.status, 0); assert.match(bad.stderr, /GMS_R2_BUCKET_INVALID/);
});
