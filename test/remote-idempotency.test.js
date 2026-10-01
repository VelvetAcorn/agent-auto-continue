'use strict';
// Regression tests for durable idempotency: a key is reserved before any job exists,
// a crash between the two saves is reconciled, and unexpired keys are never evicted.
const test = require('node:test');
const assert = require('node:assert/strict');
const { IdempotencyStore } = require('../lib/remote/idempotency');
const { startRemote } = require('./remote-fixture');

// A durable store whose "disk" is a JSON snapshot taken on every successful persist.
function durableStore({ disk = [], now = () => Date.now(), failPersist = () => false } = {}) {
  const state = { disk };
  const store = new IdempotencyStore({ entries: disk, now, persist: () => { if (failPersist()) throw new Error('Disk full'); state.disk = JSON.parse(JSON.stringify(store.toJSON())); } });
  return { store, state };
}

function jobsFixture() {
  const jobs = [];
  let next = 0;
  return {
    jobs,
    create: (pending, now = Date.now()) => async () => {
      const job = { id: `job-${++next}`, ...pending, createdAt: new Date(now).toISOString() };
      jobs.push(job);
      return job;
    },
    locate: (reserved, since) => jobs.filter((job) => job.threadId === reserved.threadId && job.message === reserved.message &&
      job.scheduleAt === reserved.scheduleAt && Date.parse(job.createdAt) >= Date.parse(since) - 1000).map((job) => job.id)
  };
}

const pending = { threadId: 'thread-a', message: 'Continue', scheduleAt: '2099-01-01T00:00:00.000Z' };
const request = { threadId: 'thread-a', delayMinutes: 30 };

test('R1: a key that cannot be saved refuses the create, so a retry cannot duplicate it', async (t) => {
  const f = await startRemote();
  t.after(f.close);
  const body = { threadId: 'thread-a', delayMinutes: 30 };
  f.setSaveFailure(true);
  const refused = await f.request('POST', '/v1/jobs', { body, headers: { 'Idempotency-Key': 'phone-1' } });
  assert.equal(refused.status, 503);
  assert.equal(refused.body.error.code, 'storage_unavailable');
  assert.equal(f.service.jobs.length, 0, 'nothing is scheduled without a durable key');
  f.setSaveFailure(false);
  assert.equal((await f.request('POST', '/v1/jobs', { body, headers: { 'Idempotency-Key': 'phone-1' } })).status, 201);
  assert.equal((await f.request('POST', '/v1/jobs', { body, headers: { 'Idempotency-Key': 'phone-1' } })).status, 200);
  assert.equal(f.service.jobs.length, 1);
});

test('R1: the key is saved before the job is created', async () => {
  const { store, state } = durableStore();
  const fixture = jobsFixture();
  let diskWhenCreating;
  await store.run({ tokenId: 'tok', key: 'k1', request, pending, locate: fixture.locate, create: async () => { diskWhenCreating = state.disk; return fixture.create(pending)(); } });
  assert.equal(diskWhenCreating.length, 1, 'a reservation is on disk before create() runs');
  assert.equal(diskWhenCreating[0].jobId, undefined);
  assert.deepEqual(diskWhenCreating[0].pending, pending);
  assert.equal(state.disk[0].jobId, 'job-1', 'the job ID is bound afterwards');
});

test('R1: after a crash between saving the key and the job ID, a retry finds the saved job', async () => {
  const fixture = jobsFixture();
  // First process: the job is saved, then the process stops before the key's job ID is written.
  let crashed = false;
  const first = durableStore({ failPersist: () => crashed });
  await first.store.run({ tokenId: 'tok', key: 'k1', request, pending, locate: fixture.locate,
    create: async () => { const job = await fixture.create(pending)(); crashed = true; return job; } });
  assert.equal(first.state.disk[0].jobId, undefined, 'only the reservation reached disk');
  // Restarted process: loads the reservation from disk and is retried with the same key.
  const restarted = durableStore({ disk: first.state.disk });
  let creates = 0;
  const retry = await restarted.store.run({ tokenId: 'tok', key: 'k1', request, pending, locate: fixture.locate, create: async () => { creates++; return fixture.create(pending)(); } });
  assert.deepEqual(retry, { replayed: true, jobId: 'job-1' });
  assert.equal(creates, 0, 'no duplicate job');
  assert.equal(fixture.jobs.length, 1);
  assert.equal(restarted.state.disk[0].jobId, 'job-1', 'the recovered binding is saved');
});

test('R1: a crash before the job was saved lets the retry create it exactly once', async () => {
  const fixture = jobsFixture();
  const reservationOnly = [{ scope: 'tok:k1', tokenId: 'tok', fingerprint: require('node:crypto').createHash('sha256').update(JSON.stringify(request)).digest('hex'), at: new Date().toISOString(), pending }];
  const { store } = durableStore({ disk: reservationOnly });
  const result = await store.run({ tokenId: 'tok', key: 'k1', request, pending, locate: fixture.locate, create: fixture.create(pending) });
  assert.equal(result.replayed, false);
  assert.equal(fixture.jobs.length, 1);
  assert.equal((await store.run({ tokenId: 'tok', key: 'k1', request, pending, locate: fixture.locate, create: fixture.create(pending) })).replayed, true);
  assert.equal(fixture.jobs.length, 1);
});

test('R1: an unidentifiable earlier attempt answers 409 instead of guessing', async () => {
  const fixture = jobsFixture();
  await fixture.create(pending)();
  await fixture.create(pending)();
  const reservationOnly = [{ scope: 'tok:k1', tokenId: 'tok', fingerprint: require('node:crypto').createHash('sha256').update(JSON.stringify(request)).digest('hex'), at: new Date(Date.now() - 500).toISOString(), pending }];
  const { store } = durableStore({ disk: reservationOnly });
  await assert.rejects(store.run({ tokenId: 'tok', key: 'k1', request, pending, locate: fixture.locate, create: fixture.create(pending) }),
    (error) => error.status === 409 && error.code === 'idempotency_indeterminate' && /list_jobs/.test(error.message));
  assert.equal(fixture.jobs.length, 2);
});

test('R2: unexpired keys are never evicted; at capacity new keys are refused before creating', async () => {
  let time = Date.parse('2026-10-01T00:00:00Z');
  const { store } = durableStore({ now: () => time });
  const fixture = jobsFixture();
  for (let index = 0; index < 1000; index++) {
    await store.run({ tokenId: 'tok', key: `k${index}`, request: { index }, pending: { ...pending, message: `m${index}` }, locate: fixture.locate, create: fixture.create({ ...pending, message: `m${index}` }, time) });
  }
  let created = false;
  await assert.rejects(store.run({ tokenId: 'tok', key: 'k-extra', request: { index: 'extra' }, pending, locate: fixture.locate, create: async () => { created = true; return { id: 'x' }; } }),
    (error) => error.status === 429 && error.code === 'idempotency_capacity');
  assert.equal(created, false, 'nothing is created when the key cannot be kept');
  const oldest = await store.run({ tokenId: 'tok', key: 'k0', request: { index: 0 }, pending, locate: fixture.locate, create: async () => { created = true; return { id: 'dup' }; } });
  assert.deepEqual(oldest, { replayed: true, jobId: 'job-1' }, 'the oldest key still protects its retry');
  assert.equal(created, false);
  // Another device is unaffected by one device's full quota.
  assert.equal((await store.run({ tokenId: 'other', key: 'k0', request, pending, locate: fixture.locate, create: fixture.create(pending, time) })).replayed, false);
  // Keys expire after 24 hours, which frees capacity.
  time += 24 * 60 * 60_000 + 1;
  assert.equal((await store.run({ tokenId: 'tok', key: 'k-extra', request: { index: 'extra' }, pending, locate: fixture.locate, create: fixture.create(pending, time) })).replayed, false);
});
