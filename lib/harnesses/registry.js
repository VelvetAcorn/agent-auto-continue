'use strict';

const { defineHarness, describeHarness } = require('./contract');
const { HarnessError } = require('./errors');

const DEFAULT_HARNESS = 't3';

// Holds validated adapters in registration order. Registration order is the
// order shown to users, so the long-standing T3 integration stays first.
function createHarnessRegistry(adapters = []) {
  const entries = new Map();
  const registry = {
    register(spec) {
      const adapter = defineHarness(spec);
      if (entries.has(adapter.id)) throw new TypeError(`Harness "${adapter.id}" is already registered.`);
      entries.set(adapter.id, adapter);
      return adapter;
    },
    has(id) { return typeof id === 'string' && entries.has(id); },
    get(id) {
      if (!registry.has(id)) throw new HarnessError('unknown_harness', 'That agent harness is not available in this version of the app.', { harness: typeof id === 'string' ? id.slice(0, 40) : '' });
      return entries.get(id);
    },
    list() { return [...entries.values()]; },
    describe() { return registry.list().map(describeHarness); },
    async shutdown() {
      await Promise.allSettled(registry.list().map((adapter) => adapter.shutdown?.()));
    }
  };
  for (const adapter of adapters) registry.register(adapter);
  return registry;
}

module.exports = { DEFAULT_HARNESS, createHarnessRegistry };
