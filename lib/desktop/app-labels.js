'use strict';

// Accessible names of the controls an adapter drives, in the app's own UI
// language. Apps that ship their message catalogues (Claude Desktop ships
// ion-dist/i18n/<locale>.json keyed by stable message IDs) are read at run time,
// so a German interface is matched by its German labels. English is always
// included as a fallback, and a missing or unreadable catalogue only means the
// English labels are used.
const fs = require('node:fs');
const path = require('node:path');

const LOCALE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

function readCatalogue(directory, locale, readFile) {
  if (!LOCALE.test(locale || '')) return null;
  const candidates = [locale];
  try {
    const base = locale.split('-')[0].toLowerCase();
    for (const name of fs.readdirSync(directory)) {
      const match = /^([a-z]{2,3}(?:-[A-Za-z0-9]+)*)\.json$/.exec(name);
      if (match && match[1].split('-')[0].toLowerCase() === base && !candidates.includes(match[1])) candidates.push(match[1]);
    }
  } catch { return null; }
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(readFile(path.join(directory, `${candidate}.json`), 'utf8'));
      if (value && typeof value === 'object') return value;
    } catch { /* Try the next candidate. */ }
  }
  return null;
}

// `controls` maps a control name to { ids: [message IDs], english: [labels] }.
// `catalogueDirectory` is a path, null, or a function returning either, so the
// app's current location can be used once it is known.
function createAppLabels({ catalogueDirectory = null, controls, readFile = fs.readFileSync }) {
  const cache = new Map();
  return function labelsFor(locale) {
    const directory = typeof catalogueDirectory === 'function' ? catalogueDirectory() : catalogueDirectory;
    const key = `${directory || ''}\n${String(locale || '')}`;
    if (cache.has(key)) return cache.get(key);
    const language = String(locale || '');
    const catalogue = directory && language && !/^en(-|$)/i.test(language) ? readCatalogue(directory, language, readFile) : null;
    const labels = {};
    for (const [name, spec] of Object.entries(controls)) {
      const localised = catalogue ? spec.ids.map((id) => catalogue[id]).filter((value) => typeof value === 'string' && value.trim()) : [];
      labels[name] = [...new Set([...localised, ...spec.english])];
    }
    cache.set(key, labels);
    return labels;
  };
}

module.exports = { createAppLabels };
