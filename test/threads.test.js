'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normaliseThreads } = require('../lib/threads');

test('verified settlement filter excludes settled and archived, preserves unknown, sorts recent first', () => {
  const snapshot = { projects: [{ id: 'p', title: 'Project' }], threads: [
    { id: 'old', updatedAt: '2026-09-01T00:00:00Z', settledOverride: null, projectId: 'p' },
    { id: 'settled', updatedAt: '2026-09-30T00:00:00Z', settledOverride: 'settled' },
    { id: 'recent', updatedAt: '2026-09-29T00:00:00Z', settledOverride: 'active' },
    { id: 'unknown', updatedAt: 'invalid', settledOverride: 'future-state' },
    { id: 'missing' },
    { id: 'archived', archivedAt: '2026-09-28T00:00:00Z' }
  ] };
  const rows = normaliseThreads(snapshot);
  assert.deepEqual(rows.map(x => x.id), ['recent', 'old', 'missing', 'unknown']);
  assert.equal(rows.find(x => x.id === 'old').projectName, 'Project');
  assert.equal(rows.find(x => x.id === 'unknown').state, 'unknown');
  assert.equal(rows.find(x => x.id === 'missing').updatedAt, null);
  assert.deepEqual(normaliseThreads(snapshot, { showSettled: true }).map(x => x.id), ['settled', 'recent', 'old', 'missing', 'unknown']);
});
