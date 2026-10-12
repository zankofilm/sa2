import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const base=await fs.mkdtemp(path.join(os.tmpdir(),'madreseyar-push-test-'));
process.env.MADRESEYAR_DATA_DIR=base;
process.env.MADRESEYAR_FCM_ENABLED='0';
const push=await import('../server-integration/INSTALL-ROOT/shared/mobile-push.mjs');
const tokenA='a'.repeat(100),tokenB='b'.repeat(100),hash='1'.repeat(64);
test('reject malformed FCM/device identifier and invalid session',async()=>{
  await assert.rejects(()=>push.registerPushDevice('s','tiny',tokenA,hash),/معتبر نیست/);
  await assert.rejects(()=>push.registerPushDevice('s','install_1234567890','bad',hash),/معتبر نیست/);
  await assert.rejects(()=>push.registerPushDevice('s','install_1234567890',tokenA,'invalid'),/معتبر نیست/);
});
test('register scoped to authenticated student and move device between accounts',async()=>{
  let a=await push.registerPushDevice('student1','install_1234567890',tokenA,hash);
  assert.equal(a.ok,true); assert.equal(a.enabled,false);
  let rows=JSON.parse(await fs.readFile(path.join(base,'push-devices.json')));
  assert.equal(rows.length,1);assert.equal(rows[0].studentId,'student1');
  await push.registerPushDevice('student2','install_1234567890',tokenB,hash);
  rows=JSON.parse(await fs.readFile(path.join(base,'push-devices.json')));
  assert.equal(rows.length,1);assert.equal(rows[0].studentId,'student2');
  await push.unregisterPushDevice('student1','install_1234567890');
  rows=JSON.parse(await fs.readFile(path.join(base,'push-devices.json')));
  assert.equal(rows.length,1);
  await push.unregisterPushDevice('student2','install_1234567890');
  rows=JSON.parse(await fs.readFile(path.join(base,'push-devices.json')));
  assert.equal(rows.length,0);
});
test('send disabled without credentials and cannot claim delivery',async()=>{
  assert.deepEqual(await push.sendPushToStudents(['student1'],{title:'hi'},new Set([hash])),{enabled:false,sent:0});
});
