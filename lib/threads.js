'use strict';

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

function normaliseThreads(snapshot, { showSettled = false } = {}) {
  const projects = new Map((snapshot.projects || []).filter((project) => project && typeof project.id === 'string').map((project) => [project.id, project.title || project.name || project.id]));
  return snapshot.threads.filter((thread) => thread && typeof thread.id === 'string' && !thread.archivedAt)
    .map((thread) => ({
      id: thread.id, title: thread.title || '(Untitled thread)', projectId: thread.projectId || '',
      projectName: projects.get(thread.projectId) || thread.projectId || '',
      updatedAt: validTimestamp(thread.updatedAt),
      // T3 0.0.40 sidebar explicitly filters the override, not idle/session status.
      state: thread.settledOverride === 'settled' ? 'settled' : thread.settledOverride === 'active' || thread.settledOverride === null ? 'active' : 'unknown',
      settled: thread.settledOverride === 'settled' ? true : thread.settledOverride === 'active' || thread.settledOverride === null ? false : null
    }))
    .filter((thread) => showSettled || thread.settled !== true)
    .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0) || a.id.localeCompare(b.id));
}
module.exports = { normaliseThreads, validTimestamp };
