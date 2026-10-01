'use strict';

// Validates and freezes an app profile, so a typo in a contact point fails at
// load time rather than as a confusing delivery failure.
function fail(name, problem) {
  throw new TypeError(`App profile "${name}" is invalid: ${problem}.`);
}
function freeze(value) {
  if (!value || typeof value !== 'object' || value instanceof RegExp || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freeze(child);
  return Object.freeze(value);
}
const strings = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');

function defineProfile(profile) {
  const name = profile?.harness || '?';
  for (const key of ['harness', 'appLabel', 'bundleId', 'verifiedVersion']) if (typeof profile[key] !== 'string' || !profile[key]) fail(name, `${key} is required`);
  if (!strings(profile.appCandidates) || !profile.appCandidates.length) fail(name, 'appCandidates must list app bundle paths');
  if (!strings(profile.deepLink?.schemes) || !/^[a-z][a-z0-9+.-]*:\/\/.*\{id\}/.test(profile.deepLink?.template || '')) fail(name, 'deepLink needs schemes and a template containing {id}');
  if (!profile.deepLink.schemes.includes(profile.deepLink.template.split(':')[0])) fail(name, 'the deep link template must use one of its schemes');
  if (!(profile.conversationId instanceof RegExp)) fail(name, 'conversationId must be a RegExp');
  if (!['urlSegment', 'title'].includes(profile.content?.by)) fail(name, 'content.by must be urlSegment or title');
  for (const control of ['composer', 'send', 'stop']) {
    const spec = profile.controls?.[control];
    if (!strings(spec?.ids) || !strings(spec?.english)) fail(name, `controls.${control} needs ids and english arrays`);
  }
  if (!profile.controls.composer.english.length || !profile.controls.send.english.length) fail(name, 'composer and send need English labels');
  for (const [key, file] of Object.entries(profile.bundledFiles || {})) {
    if (typeof file?.path !== 'string' || file.path.startsWith('/') || file.path.includes('..') || typeof file.required !== 'boolean') fail(name, `bundledFiles.${key} needs a relative path and required`);
  }
  return freeze({ ui: {}, bundledFiles: {}, ...profile });
}

// The app's own link to one conversation.
function deepLinkFor(profile, id) {
  return profile.deepLink.template.replace('{id}', encodeURIComponent(id));
}

module.exports = { deepLinkFor, defineProfile };
