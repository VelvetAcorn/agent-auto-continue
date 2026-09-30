(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SchedulerTime = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const pad = (value) => String(value).padStart(2, '0');
  function formatter(zone) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  }
  function parts(value, zone) {
    const date = new Date(value);
    if (!Number.isFinite(date.valueOf())) throw new Error('That date is unavailable.');
    const result = {};
    for (const part of formatter(zone).formatToParts(date)) if (part.type !== 'literal') result[part.type] = Number(part.value);
    return result;
  }
  function offsetAt(value, zone) {
    const p = parts(value, zone);
    return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(new Date(value).valueOf() / 1000) * 1000) / 60000);
  }
  function offsetLabel(minutes) {
    return `UTC${minutes >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`;
  }
  function formatInstant(value, zone) {
    const p = parts(value, zone);
    const offsetMinutes = offsetAt(value, zone);
    return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, time: `${pad(p.hour)}:${pad(p.minute)}`, seconds: pad(p.second), offsetMinutes, offset: offsetLabel(offsetMinutes), timeZone: zone };
  }
  function parseWall(date, time) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !/^\d{2}:\d{2}$/.test(time || '')) throw new Error('Use yyyy-mm-dd for the date and HH:mm for the 24-hour time.');
    const [year, month, day] = date.split('-').map(Number);
    const [hour, minute] = time.split(':').map(Number);
    const stamp = Date.UTC(year, month - 1, day, hour, minute);
    const check = new Date(stamp);
    if (year < 1000 || hour > 23 || minute > 59 || check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) throw new Error('Enter a real calendar date and a valid 24-hour time.');
    return { year, month, day, hour, minute, stamp };
  }
  function wallTimeCandidates(date, time, zone) {
    const p = parseWall(date, time);
    try { formatter(zone); } catch { throw new Error('Choose a valid IANA timezone, such as Europe/London.'); }
    // Sample both sides of a transition; candidate instants must round-trip exactly.
    const offsets = new Set();
    for (let hour = -36; hour <= 36; hour += 3) offsets.add(offsetAt(p.stamp + hour * 3600000, zone));
    return [...offsets].map(offsetMinutes => ({ iso: new Date(p.stamp - offsetMinutes * 60000).toISOString(), offsetMinutes }))
      .filter(candidate => { const actual = formatInstant(candidate.iso, zone); return actual.date === date && actual.time === time; })
      .sort((a, b) => a.iso.localeCompare(b.iso));
  }
  function resolveWallTime(date, time, zone, chosenISO, now = Date.now()) {
    const candidates = wallTimeCandidates(date, time, zone);
    if (!candidates.length) throw new Error('That local time does not exist because the clocks move forward. Choose another time.');
    const selected = candidates.length === 1 ? candidates[0] : candidates.find(candidate => candidate.iso === chosenISO);
    if (!selected) throw new Error('That time occurs twice when the clocks move back. Choose which UTC offset to use.');
    if (Date.parse(selected.iso) <= now) throw new Error('Choose a time in the future.');
    return selected;
  }
  function quickTime(value, zone, now = Date.now()) {
    if (value !== 'tomorrow') return formatInstant(now + Number(value) * 60000, zone);
    const p = parts(now, zone);
    const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
    return { date: `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`, time: '09:00' };
  }
  return { formatInstant, wallTimeCandidates, resolveWallTime, quickTime, offsetLabel };
});
