'use strict';

// Recognises provider usage-limit wording and extracts a reset time when the
// text includes one. Formats are not documented contracts, so every parse is
// defensive and an unparseable reset time is reported as null.
const LIMIT_PATTERN = /usage limit|limit reached|hit your (?:usage )?limit|reached your [\w .-]{0,40}limit|rate[ _-]?limit|quota (?:exceeded|reached)|too many requests|out of (?:usage|credits)|credits? (?:depleted|exhausted)|\blimit will reset\b|\bresets? (?:at |in )?\d/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function validZone(zone) {
  if (!zone) return null;
  try { new Intl.DateTimeFormat('en', { timeZone: zone }); return zone; } catch { return null; }
}

function offsetMinutes(ms, zone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' }).formatToParts(new Date(ms));
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(parts.find((part) => part.type === 'timeZoneName')?.value || '');
  return match ? (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) : 0;
}

function zonedParts(ms, zone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric', hourCycle: 'h23', hour: 'numeric', minute: 'numeric' })
    .formatToParts(new Date(ms)).map((part) => [part.type, Number(part.value)]));
  return { year: parts.year, month: parts.month, day: parts.day };
}

// Converts a wall-clock time in `zone` to an instant, correcting for the zone offset twice.
function wallToInstant({ year, month, day, hour, minute }, zone) {
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let pass = 0; pass < 2; pass++) guess = Date.UTC(year, month - 1, day, hour, minute) - offsetMinutes(guess, zone) * 60_000;
  return guess;
}

function hour24(hour, meridiem) {
  if (!meridiem) return hour;
  const pm = /p/i.test(meridiem);
  return (hour % 12) + (pm ? 12 : 0);
}

// Returns an ISO instant for the first matching reset expression, or null.
function parseResetTime(text, now = Date.now(), fallbackZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const value = String(text || '');
  const epoch = /\|(\d{10})(?:\d{3})?\b/.exec(value);
  if (epoch) return new Date(Number(epoch[1]) * 1000).toISOString();
  const iso = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))\b/.exec(value);
  if (iso && Number.isFinite(Date.parse(iso[1]))) return new Date(Date.parse(iso[1])).toISOString();
  const duration = /\b(?:try again|resets?|available again)\s+in\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,]*(?:and\s+)?)+)/i.exec(value);
  if (duration) {
    let ms = 0;
    for (const [, amount, unit] of duration[1].matchAll(/(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi)) {
      const key = unit.toLowerCase()[0] === 'd' ? 86_400_000 : unit.toLowerCase()[0] === 'h' ? 3_600_000 : unit.toLowerCase().startsWith('s') ? 1000 : 60_000;
      ms += Number(amount) * key;
    }
    if (ms > 0) return new Date(now + ms).toISOString();
  }
  const clock = /\b(?:resets?|reset at|will reset at|try again (?:at|after)|available again at)\s+(?:on\s+)?(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?(?:\s*\(([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+|UTC)\))?/i.exec(value);
  if (clock) {
    const rawHour = Number(clock[3]);
    const hour = hour24(rawHour, clock[5]);
    const minute = Number(clock[4] || 0);
    if ((clock[5] ? rawHour < 1 || rawHour > 12 : rawHour > 23) || minute > 59 || (!clock[5] && !clock[4])) return null;
    const zone = validZone(clock[6]) || validZone(fallbackZone) || 'UTC';
    const today = zonedParts(now, zone);
    let date = clock[1] ? { year: today.year, month: MONTHS.indexOf(clock[1].toLowerCase().slice(0, 3)) + 1, day: Number(clock[2]) } : today;
    let instant = wallToInstant({ ...date, hour, minute }, zone);
    if (clock[1] && instant < now - 86_400_000) instant = wallToInstant({ ...date, year: date.year + 1, hour, minute }, zone);
    if (!clock[1]) {
      for (let days = 0; instant <= now && days < 2; days++) {
        const next = zonedParts(Date.UTC(date.year, date.month - 1, date.day + 1, 12), 'UTC');
        date = next;
        instant = wallToInstant({ ...date, hour, minute }, zone);
      }
    }
    return Number.isFinite(instant) ? new Date(instant).toISOString() : null;
  }
  return null;
}

// Returns { message, resetsAt } when the text reads as a usage limit, otherwise null.
function matchUsageLimit(text, now = Date.now(), fallbackZone) {
  const value = String(text || '');
  if (!LIMIT_PATTERN.test(value)) return null;
  return { message: value.replace(/\s+/g, ' ').trim().slice(0, 240), resetsAt: parseResetTime(value, now, fallbackZone) };
}

module.exports = { matchUsageLimit, parseResetTime };
