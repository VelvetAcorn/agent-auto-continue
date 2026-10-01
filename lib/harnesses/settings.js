'use strict';

// Generic storage, validation and public presentation for adapter `settings`
// descriptors. Values live in config.json under `harnesses[<id>][<key>]`.
const MAX_TEXT = 1024;
const MAX_SECRET = 4096;

function coerce(setting, value) {
  if (setting.type === 'port') {
    const port = Number(value);
    return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length <= (setting.type === 'secret' ? MAX_SECRET : MAX_TEXT) ? text : null;
}

// Drops unknown harnesses/keys and invalid values from persisted configuration.
function normaliseHarnessSettings(adapters, raw) {
  const result = {};
  for (const adapter of adapters) {
    const stored = raw && typeof raw === 'object' && raw[adapter.id] && typeof raw[adapter.id] === 'object' ? raw[adapter.id] : {};
    const values = {};
    for (const setting of adapter.settings) {
      const value = coerce(setting, stored[setting.key]);
      if (value !== null && value !== '') values[setting.key] = value;
    }
    if (Object.keys(values).length) result[adapter.id] = values;
  }
  return result;
}

// Validates renderer input. Blank secrets keep the stored value; `clear: [key]`
// removes a stored secret explicitly. Returns the next persisted settings.
function applyHarnessSettingsInput(adapters, current, input) {
  if (input === undefined) return current;
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid harness settings.');
  const next = JSON.parse(JSON.stringify(current || {}));
  for (const [id, values] of Object.entries(input)) {
    const adapter = adapters.find((item) => item.id === id);
    if (!adapter) throw new Error('Unknown agent harness in settings.');
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error(`Invalid ${adapter.label} settings.`);
    const target = next[id] || {};
    for (const [key, value] of Object.entries(values)) {
      if (key === 'clear') {
        if (!Array.isArray(value)) throw new Error(`Invalid ${adapter.label} settings.`);
        for (const name of value) if (adapter.settings.some((setting) => setting.key === name)) delete target[name];
        continue;
      }
      const setting = adapter.settings.find((item) => item.key === key);
      if (!setting) throw new Error(`Unknown ${adapter.label} setting.`);
      if (setting.type === 'secret' && (value === undefined || value === '')) continue;
      if (setting.type !== 'port' && typeof value === 'string' && value.trim() === '') { delete target[key]; continue; }
      const coerced = coerce(setting, value);
      if (coerced === null) throw new Error(setting.type === 'port' ? `${adapter.label} port must be a whole number between 1 and 65535.` : `${setting.label} is too long.`);
      target[key] = coerced;
    }
    if (Object.keys(target).length) next[id] = target; else delete next[id];
  }
  return next;
}

// Effective value: environment (for descriptors naming one), then stored, then default.
function resolveHarnessSettings(adapter, stored = {}, env = {}) {
  const values = {};
  for (const setting of adapter.settings) {
    const fromEnv = setting.env && typeof env[setting.env] === 'string' && env[setting.env].trim() ? coerce(setting, env[setting.env]) : null;
    values[setting.key] = fromEnv ?? stored[setting.key] ?? setting.default;
  }
  return values;
}

// Secrets are never returned; only whether one is stored or supplied by the environment.
function publicHarnessSettings(adapters, stored = {}, env = {}) {
  const result = {};
  for (const adapter of adapters) {
    const values = {};
    for (const setting of adapter.settings) {
      const own = stored[adapter.id]?.[setting.key];
      const fromEnvironment = Boolean(setting.env && typeof env[setting.env] === 'string' && env[setting.env].trim());
      values[setting.key] = setting.type === 'secret'
        ? { hasStoredValue: own !== undefined && own !== '', usingEnvironment: fromEnvironment }
        : { value: own ?? setting.default, usingEnvironment: fromEnvironment };
    }
    result[adapter.id] = values;
  }
  return result;
}

module.exports = { applyHarnessSettingsInput, normaliseHarnessSettings, publicHarnessSettings, resolveHarnessSettings };
