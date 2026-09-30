'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { formatInstant, wallTimeCandidates, resolveWallTime, quickTime } = require('../renderer/date-time');
const before = Date.parse('2020-01-01T00:00:00Z');

test('ISO date and 24-hour formatting follows the selected zone at midnight and fractional offsets', () => {
  const utc = formatInstant('2026-09-30T00:00:00Z', 'UTC');
  assert.equal(utc.date, '2026-09-30');
  assert.equal(utc.time, '00:00');
  const kathmandu = formatInstant('2026-09-30T20:00:00Z', 'Asia/Kathmandu');
  assert.equal(kathmandu.date, '2026-10-01');
  assert.equal(kathmandu.time, '01:45');
  assert.equal(kathmandu.offset, 'UTC+05:45');
});

test('DST gap rejects nonexistent wall times rather than silently shifting them', () => {
  assert.deepEqual(wallTimeCandidates('2026-03-29', '01:30', 'Europe/London'), []);
  assert.throws(() => resolveWallTime('2026-03-29', '01:30', 'Europe/London', undefined, before), /does not exist/);
  assert.throws(() => resolveWallTime('2026-03-08', '02:30', 'America/New_York', undefined, before), /does not exist/);
});

test('DST overlap requires an explicit occurrence and keeps its fixed instant', () => {
  const choices = wallTimeCandidates('2026-10-25', '01:30', 'Europe/London');
  assert.deepEqual(choices, [{ iso: '2026-10-25T00:30:00.000Z', offsetMinutes: 60 }, { iso: '2026-10-25T01:30:00.000Z', offsetMinutes: 0 }]);
  assert.throws(() => resolveWallTime('2026-10-25', '01:30', 'Europe/London', undefined, before), /occurs twice/);
  assert.equal(resolveWallTime('2026-10-25', '01:30', 'Europe/London', choices[1].iso, before).iso, choices[1].iso);
  assert.equal(wallTimeCandidates('2026-11-01', '01:30', 'America/New_York').length, 2);
});

test('half-hour DST changes produce two distinct valid occurrences', () => {
  const choices = wallTimeCandidates('2026-04-05', '01:45', 'Australia/Lord_Howe');
  assert.equal(choices.length, 2);
  assert.equal(Date.parse(choices[1].iso) - Date.parse(choices[0].iso), 30 * 60_000);
});

test('date entry rejects invalid calendar dates, invalid zones, 24:00 and past instants', () => {
  for (const [date, time] of [['2026-02-29', '12:00'], ['2026-04-31', '12:00'], ['30-09-2026', '12:00'], ['2026-09-30', '24:00'], ['2026-09-30', '12:60']]) {
    assert.throws(() => wallTimeCandidates(date, time, 'UTC'));
  }
  assert.throws(() => wallTimeCandidates('2026-09-30', '12:00', 'Invented/Zone'), /valid IANA/);
  assert.throws(() => resolveWallTime('2026-09-30', '12:00', 'UTC', undefined, Date.parse('2026-09-30T12:00:00Z')), /future/);
});

test('Tomorrow uses the selected local calendar at 09:00 across year and DST boundaries', () => {
  assert.deepEqual(quickTime('tomorrow', 'Pacific/Auckland', Date.parse('2026-12-31T01:00:00Z')), { date: '2027-01-01', time: '09:00' });
  assert.deepEqual(quickTime('tomorrow', 'Europe/London', Date.parse('2026-03-28T23:30:00Z')), { date: '2026-03-29', time: '09:00' });
  assert.equal(quickTime(30, 'UTC', Date.parse('2026-12-31T23:45:00Z')).date, '2027-01-01');
});
