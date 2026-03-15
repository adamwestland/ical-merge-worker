/**
 * Tests for iCal Merge Worker.
 * Run with: node test/test.mjs
 */

// ── Simulated functions (mirrors src/index.ts logic) ──────────────────────────

function extractEvents(icalText, prefix) {
  const unfolded = icalText.replace(/\r?\n[ \t]/g, '');
  const events = [];
  const lines = unfolded.split(/\r?\n/);
  let inEvent = false;
  let eventLines = [];

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      inEvent = true;
      eventLines = [line];
    } else if (line === 'END:VEVENT' && inEvent) {
      eventLines.push(line);
      inEvent = false;
      if (prefix) {
        const prefixed = eventLines.map(l =>
          l.startsWith('SUMMARY:') ? `SUMMARY:${prefix} ${l.slice(8)}` : l
        );
        events.push(prefixed.join('\r\n'));
      } else {
        events.push(eventLines.join('\r\n'));
      }
    } else if (inEvent) {
      eventLines.push(line);
    }
  }
  return events;
}

function timingSafeEqual(a, b) {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  const lengthMismatch = aBytes.length !== bBytes.length;
  const compareTarget = lengthMismatch ? aBytes : bBytes;
  let mismatch = lengthMismatch ? 1 : 0;
  for (let i = 0; i < aBytes.length; i++) {
    mismatch |= aBytes[i] ^ compareTarget[i];
  }
  return mismatch === 0;
}

function loadFeedConfigs(feedMeta, feedUrls) {
  return feedMeta.map(meta => ({
    id: meta.id,
    name: meta.name,
    url: feedUrls[meta.id] || '',
    prefix: meta.prefix,
  }));
}

function loadViewConfig(viewName, viewConfigs, viewTokens) {
  const token = viewTokens[viewName];
  const config = viewConfigs[viewName];
  if (!token || !config) return null;
  return { token, feeds: config.feeds, calendarName: config.calendarName };
}

function authenticateView(url, viewConfigs, viewTokens) {
  const viewName = url.searchParams.get('view') || 'full';
  const token = url.searchParams.get('token') || '';
  const dummyToken = 'x'.repeat(64);
  const expectedToken = viewTokens[viewName] || dummyToken;
  const tokenValid = timingSafeEqual(token, expectedToken);
  const tokenExists = viewName in viewTokens;
  if (!tokenValid || !tokenExists) return null;
  const config = viewConfigs[viewName];
  if (!config) return null;
  return {
    view: { token: viewTokens[viewName], feeds: config.feeds, calendarName: config.calendarName },
    viewName,
  };
}

function resolveView(viewTokens, viewName, token) {
  const dummyToken = 'x'.repeat(64);
  const expectedToken = viewTokens[viewName] || dummyToken;
  const tokenValid = timingSafeEqual(token, expectedToken);
  const tokenExists = viewName in viewTokens;
  return tokenValid && tokenExists;
}

function filterFeeds(allFeeds, feedIds) {
  const idSet = new Set(feedIds);
  return allFeeds.filter(f => idSet.has(f.id));
}

function prefixSummary(lines, prefix) {
  return lines.map(line => {
    if (line.startsWith('SUMMARY:')) {
      return `SUMMARY:${prefix} ${line.slice(8)}`;
    }
    return line;
  });
}

function extractTimezones(icalText) {
  const unfolded = icalText.replace(/\r?\n[ \t]/g, '');
  const timezones = [];
  const lines = unfolded.split(/\r?\n/);
  let inTZ = false;
  let tzLines = [];
  for (const line of lines) {
    if (line === 'BEGIN:VTIMEZONE') {
      inTZ = true;
      tzLines = [line];
    } else if (line === 'END:VTIMEZONE' && inTZ) {
      tzLines.push(line);
      inTZ = false;
      timezones.push(tzLines.join('\r\n'));
    } else if (inTZ) {
      tzLines.push(line);
    }
  }
  return timezones;
}

function parseEvent(tagged) {
  const lines = tagged.raw.split(/\r?\n/);
  const fields = {};
  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const fullKey = line.slice(0, colonIdx);
    let key = fullKey;
    const semiIdx = key.indexOf(';');
    if (semiIdx !== -1) {
      const params = fullKey.slice(semiIdx + 1);
      key = key.slice(0, semiIdx);
      const tzMatch = params.match(/TZID=([^;]+)/);
      if (tzMatch) {
        fields[key + '_TZID'] = tzMatch[1];
      }
    }
    fields[key] = line.slice(colonIdx + 1);
  }
  const startUTC = parseICalDateTime(fields['DTSTART'] || '', fields['DTSTART_TZID']);
  return { lines, fields, feedId: tagged.feedId, prefix: tagged.prefix, startUTC };
}

function normalizeTitle(summary) {
  return summary
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\b(to|from|the|a|an)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function diceCoefficient(a, b) {
  if (a === b) return 1.0;
  if (a.length < 2 || b.length < 2) return 0.0;

  const bigrams = (s) => {
    const map = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const bi = s.slice(i, i + 2);
      map.set(bi, (map.get(bi) || 0) + 1);
    }
    return map;
  };

  const aBi = bigrams(a);
  const bBi = bigrams(b);
  let intersection = 0;

  for (const [bi, count] of aBi) {
    intersection += Math.min(count, bBi.get(bi) || 0);
  }

  return (2.0 * intersection) / (a.length - 1 + b.length - 1);
}

function titlesMatch(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  return diceCoefficient(na, nb) >= 0.75;
}

const WINDOWS_TZID_MAP = {
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Atlantic Standard Time': 'America/Halifax',
  'Newfoundland Standard Time': 'America/St_Johns',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Alaskan Standard Time': 'America/Anchorage',
  'US Mountain Standard Time': 'America/Phoenix',
  'Canada Central Standard Time': 'America/Regina',
  'UTC': 'UTC',
  'GMT Standard Time': 'Europe/London',
  'Romance Standard Time': 'Europe/Paris',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central European Standard Time': 'Europe/Warsaw',
  'E. Europe Standard Time': 'Europe/Bucharest',
  'FLE Standard Time': 'Europe/Helsinki',
  'GTB Standard Time': 'Europe/Athens',
  'Russian Standard Time': 'Europe/Moscow',
  'Israel Standard Time': 'Asia/Jerusalem',
  'Arabian Standard Time': 'Asia/Dubai',
  'India Standard Time': 'Asia/Kolkata',
  'China Standard Time': 'Asia/Shanghai',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'New Zealand Standard Time': 'Pacific/Auckland',
  'Singapore Standard Time': 'Asia/Singapore',
  'SA Pacific Standard Time': 'America/Bogota',
  'SA Eastern Standard Time': 'America/Buenos_Aires',
  'E. South America Standard Time': 'America/Sao_Paulo',
};

function resolveTimezone(tzid) {
  if (tzid.includes('/')) return tzid;
  return WINDOWS_TZID_MAP[tzid] || null;
}

function parseICalDateTime(value, tzid) {
  // All-day: 20260315
  const dateOnly = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (dateOnly) {
    const [, y, mo, d] = dateOnly;
    return Date.UTC(+y, +mo - 1, +d);
  }

  // DateTime with Z — already UTC
  if (value.endsWith('Z')) {
    const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
    if (!match) return null;
    const [, y, mo, d, h, mi, s] = match;
    return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  }

  // DateTime without Z — local time, optionally with TZID
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;

  if (!tzid) {
    return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  }

  const resolved = resolveTimezone(tzid);
  if (!resolved) {
    return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  }
  return localTimeToUTC(+y, +mo - 1, +d, +h, +mi, +s, resolved);
}

function localTimeToUTC(y, mo, d, h, mi, s, tzid) {
  const guessUTC = Date.UTC(y, mo, d, h, mi, s);
  const localStr = new Date(guessUTC).toLocaleString('sv-SE', { timeZone: tzid });
  const [datePart, timePart] = localStr.split(' ');
  const [ly, lmo, ld] = datePart.split('-').map(Number);
  const [lh, lmi, ls] = timePart.split(':').map(Number);
  const localAsUTC = Date.UTC(ly, lmo - 1, ld, lh, lmi, ls);
  return guessUTC - (localAsUTC - guessUTC);
}

function timesOverlap(a, b) {
  if (a.startUTC === null || b.startUTC === null) return false;
  return Math.abs(a.startUTC - b.startUTC) <= 5 * 60 * 1000;
}

function eventRichness(parsed) {
  let score = 0;
  const richFields = ['DESCRIPTION', 'LOCATION', 'GEO', 'URL', 'ATTENDEE', 'ORGANIZER'];
  for (const f of richFields) {
    if (parsed.fields[f]) score++;
  }
  score += (parsed.fields['DESCRIPTION'] || '').length;
  return score;
}

function mergeEvents(a, b) {
  const aScore = eventRichness(a);
  const bScore = eventRichness(b);
  const primary = aScore >= bScore ? a : b;
  const secondary = aScore >= bScore ? b : a;

  const primaryKeys = new Set(primary.lines.map(line => {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) return line;
    let key = line.slice(0, colonIdx);
    const semiIdx = key.indexOf(';');
    if (semiIdx !== -1) key = key.slice(0, semiIdx);
    return key;
  }));

  const newLines = [...primary.lines];
  const insertIdx = newLines.findIndex(l => l === 'END:VEVENT');

  for (const line of secondary.lines) {
    if (line === 'BEGIN:VEVENT' || line === 'END:VEVENT') continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    let key = line.slice(0, colonIdx);
    const semiIdx = key.indexOf(';');
    if (semiIdx !== -1) key = key.slice(0, semiIdx);
    if (key === 'UID' || key === 'DTSTAMP') continue;
    if (!primaryKeys.has(key)) {
      newLines.splice(insertIdx, 0, line);
      primaryKeys.add(key);
    }
  }

  return {
    lines: newLines,
    fields: { ...secondary.fields, ...primary.fields },
    feedId: primary.feedId,
    prefix: primary.prefix,
  };
}

function deduplicateEvents(tagged) {
  const parsed = tagged.map(t => parseEvent(t));
  const merged = new Array(parsed.length).fill(false);

  for (let i = 0; i < parsed.length; i++) {
    if (merged[i]) continue;
    if (parsed[i].fields['RRULE']) continue;

    for (let j = i + 1; j < parsed.length; j++) {
      if (merged[j]) continue;
      if (parsed[j].fields['RRULE']) continue;
      if (parsed[i].feedId === parsed[j].feedId) continue;

      if (timesOverlap(parsed[i], parsed[j]) &&
        titlesMatch(parsed[i].fields['SUMMARY'] || '', parsed[j].fields['SUMMARY'] || '')) {
        parsed[i] = mergeEvents(parsed[i], parsed[j]);
        merged[j] = true;
      }
    }
  }

  return parsed.filter((_, idx) => !merged[idx]);
}

function serializeEvent(parsed) {
  const lines = parsed.prefix ? prefixSummary(parsed.lines, parsed.prefix) : parsed.lines;
  return lines.join('\r\n');
}

// Mirrors the KV fallback logic from handleCalendar
function resolveEnabledFeeds(kvFeeds, viewFeeds) {
  return kvFeeds ? JSON.parse(kvFeeds) : viewFeeds;
}

// ── Test Data ─────────────────────────────────────────────────────────────────

const sampleIcal = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
DTSTART:20260315T100000Z
DTEND:20260315T110000Z
SUMMARY:Team Standup
UID:abc123@test.com
END:VEVENT
BEGIN:VEVENT
DTSTART:20260316T140000Z
DTEND:20260316T150000Z
SUMMARY:Lunch with a very long 
 event name that wraps across 
 multiple lines
UID:def456@test.com
END:VEVENT
END:VCALENDAR`;

// Split data: secrets vs KV config (mirrors new architecture)
const feedMeta = [
  { id: 'gmail',    name: 'Gmail',    prefix: '📧' },
  { id: 'work',     name: 'Work',     prefix: '🏢' },
  { id: 'personal', name: 'Personal', prefix: '👤' },
  { id: 'tripit',   name: 'TripIt',   prefix: '✈️' },
  { id: 'f1',       name: 'F1',       prefix: '🏎️' },
];

const feedUrls = {
  gmail: 'https://example.com/1',
  work: 'https://example.com/2',
  personal: 'https://example.com/3',
  tripit: 'https://example.com/4',
  f1: 'https://example.com/5',
};

const viewTokens = {
  full: 'abc123fulltoken',
  julie: 'xyz789julietoken',
};

const viewConfigs = {
  full: {
    feeds: ['gmail', 'work', 'personal', 'tripit', 'f1'],
    calendarName: 'Adam (all)',
  },
  julie: {
    feeds: ['gmail', 'personal', 'tripit', 'f1'],
    calendarName: "Adam's Schedule",
  },
};

// Derived (same shape as original, for existing tests)
const allFeeds = loadFeedConfigs(feedMeta, feedUrls);
const views = {
  full: loadViewConfig('full', viewConfigs, viewTokens),
  julie: loadViewConfig('julie', viewConfigs, viewTokens),
};

// ── Tests ─────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, name) {
  if (condition) {
    console.log(`✓ ${name}`);
    passed++;
  } else {
    console.error(`✗ ${name}`);
    failed++;
  }
}

// Parsing
assert(extractEvents(sampleIcal).length === 2, 'Extracts 2 events');
assert(extractEvents(sampleIcal)[1].includes('Lunch with a very long event name that wraps across multiple lines'), 'Handles line folding');
assert(extractEvents(sampleIcal, '🏢')[0].includes('SUMMARY:🏢 Team Standup'), 'Applies prefix');
assert(extractEvents(sampleIcal, undefined)[0].includes('SUMMARY:Team Standup'), 'No prefix when undefined');
assert(extractEvents('not ical').length === 0, 'Malformed input returns 0');
assert(extractEvents('BEGIN:VCALENDAR\nEND:VCALENDAR').length === 0, 'Empty cal returns 0');

// Timing-safe comparison
assert(timingSafeEqual('abc', 'abc') === true, 'Equal strings match');
assert(timingSafeEqual('abc', 'xyz') === false, 'Different strings reject');
assert(timingSafeEqual('abc', 'abcd') === false, 'Different lengths reject');
assert(timingSafeEqual('', '') === true, 'Empty strings match');
assert(timingSafeEqual('a', '') === false, 'Empty vs non-empty rejects');

// View resolution
assert(resolveView(viewTokens, 'full', 'abc123fulltoken') === true, 'Valid view + token passes');
assert(resolveView(viewTokens, 'julie', 'xyz789julietoken') === true, 'Julie view + token passes');
assert(resolveView(viewTokens, 'full', 'wrongtoken') === false, 'Wrong token rejects');
assert(resolveView(viewTokens, 'julie', 'abc123fulltoken') === false, 'Cross-view token rejects');
assert(resolveView(viewTokens, 'nonexistent', 'abc123fulltoken') === false, 'Nonexistent view rejects');
assert(resolveView(viewTokens, 'full', '') === false, 'Empty token rejects');

// Feed filtering
assert(filterFeeds(allFeeds, views.full.feeds).length === 5, 'Full view gets all 5 feeds');
assert(filterFeeds(allFeeds, views.julie.feeds).length === 4, 'Julie view gets 4 feeds (no work)');
assert(filterFeeds(allFeeds, views.julie.feeds).every(f => f.id !== 'work'), 'Julie view excludes work');
assert(filterFeeds(allFeeds, ['nonexistent']).length === 0, 'Unknown feed IDs return empty');

// normalizeTitle
assert(normalizeTitle('Flight to SFO ✈️') === normalizeTitle('flight to SFO'), 'normalizeTitle: flight numbers match case-insensitive');
assert(normalizeTitle('MEETING') === normalizeTitle('meeting'), 'normalizeTitle: case insensitive');
assert(normalizeTitle('') === '', 'normalizeTitle: empty string');

// diceCoefficient
assert(diceCoefficient('hello', 'hello') === 1.0, 'diceCoefficient: identical strings = 1.0');
assert(diceCoefficient('abc', 'xyz') < 0.5, 'diceCoefficient: different strings < 0.5');
assert(diceCoefficient('a', 'b') === 0.0, 'diceCoefficient: single chars = 0.0');

// titlesMatch
assert(titlesMatch('Flight to SFO - AA123', 'AA123 Flight SFO') === true, 'titlesMatch: flight variants match');
assert(titlesMatch('Team Standup', 'Team Standup Daily') === true, 'titlesMatch: containment match');
assert(titlesMatch('Dentist Appointment', 'Flight to SFO') === false, 'titlesMatch: unrelated events reject');

// parseICalDateTime
assert(parseICalDateTime('20260315T100000Z') === Date.UTC(2026, 2, 15, 10, 0, 0), 'parseICalDateTime: with Z');
assert(parseICalDateTime('20260315T100000') === Date.UTC(2026, 2, 15, 10, 0, 0), 'parseICalDateTime: without Z (no TZID, treated as UTC)');
assert(parseICalDateTime('invalid') === null, 'parseICalDateTime: invalid returns null');
assert(parseICalDateTime('20260315') === Date.UTC(2026, 2, 15), 'parseICalDateTime: date-only (all-day event)');

// parseICalDateTime with TZID
{
  // 10:00 AM in New York (EDT, UTC-4) = 14:00 UTC
  const result = parseICalDateTime('20260315T100000', 'America/New_York');
  assert(result === Date.UTC(2026, 2, 15, 14, 0, 0), 'parseICalDateTime: TZID America/New_York converts to UTC');
}
{
  // 10:00 AM in Toronto (EDT, UTC-4) = 14:00 UTC (same as New York)
  const result = parseICalDateTime('20260315T100000', 'America/Toronto');
  assert(result === Date.UTC(2026, 2, 15, 14, 0, 0), 'parseICalDateTime: TZID America/Toronto converts to UTC');
}
{
  // Z suffix ignores TZID — already UTC
  const result = parseICalDateTime('20260315T100000Z', 'America/New_York');
  assert(result === Date.UTC(2026, 2, 15, 10, 0, 0), 'parseICalDateTime: Z suffix ignores TZID');
}

// parseICalDateTime with Windows timezone IDs (M365/Outlook)
{
  const result = parseICalDateTime('20260315T100000', 'Eastern Standard Time');
  assert(result === Date.UTC(2026, 2, 15, 14, 0, 0), 'parseICalDateTime: Windows "Eastern Standard Time" converts to UTC');
}
{
  const result = parseICalDateTime('20260315T100000', 'Pacific Standard Time');
  assert(result === Date.UTC(2026, 2, 15, 17, 0, 0), 'parseICalDateTime: Windows "Pacific Standard Time" converts to UTC');
}
{
  // Unknown timezone falls back to UTC
  const result = parseICalDateTime('20260315T100000', 'Fake Timezone');
  assert(result === Date.UTC(2026, 2, 15, 10, 0, 0), 'parseICalDateTime: unknown timezone falls back to UTC');
}

// resolveTimezone
assert(resolveTimezone('America/Toronto') === 'America/Toronto', 'resolveTimezone: IANA passes through');
assert(resolveTimezone('Eastern Standard Time') === 'America/New_York', 'resolveTimezone: Windows maps to IANA');
assert(resolveTimezone('Fake Timezone') === null, 'resolveTimezone: unknown returns null');

// parseEvent extracts TZID from parameters
{
  const tagged = {
    raw: 'BEGIN:VEVENT\r\nDTSTART;TZID=America/Toronto:20260315T100000\r\nSUMMARY:Meeting\r\nEND:VEVENT',
    feedId: 'work',
  };
  const parsed = parseEvent(tagged);
  assert(parsed.fields['DTSTART'] === '20260315T100000', 'parseEvent: extracts DTSTART value');
  assert(parsed.fields['DTSTART_TZID'] === 'America/Toronto', 'parseEvent: extracts DTSTART_TZID');
}
{
  const tagged = {
    raw: 'BEGIN:VEVENT\r\nDTSTART:20260315T100000Z\r\nSUMMARY:Meeting\r\nEND:VEVENT',
    feedId: 'work',
  };
  const parsed = parseEvent(tagged);
  assert(parsed.fields['DTSTART_TZID'] === undefined, 'parseEvent: no TZID when not present');
}

// deduplicateEvents — merges duplicates into 1 with richer fields
{
  const tripitEvent = [
    'BEGIN:VEVENT',
    'DTSTART:20260315T100000Z',
    'DTEND:20260315T130000Z',
    'SUMMARY:Flight to SFO - AA123',
    'DESCRIPTION:Confirmation ABC123. Seat 12A.',
    'LOCATION:LAX Terminal 4',
    'UID:tripit-1@tripit.com',
    'END:VEVENT',
  ].join('\r\n');

  const m365Event = [
    'BEGIN:VEVENT',
    'DTSTART:20260315T100000Z',
    'DTEND:20260315T130000Z',
    'SUMMARY:AA123 Flight SFO',
    'UID:m365-1@outlook.com',
    'END:VEVENT',
  ].join('\r\n');

  const tagged = [
    { raw: tripitEvent, feedId: 'tripit', prefix: '✈️' },
    { raw: m365Event, feedId: 'personal', prefix: '👤' },
  ];

  const result = deduplicateEvents(tagged);
  assert(result.length === 1, 'dedup: merges duplicate flight into 1 event');
  assert(result[0].fields['DESCRIPTION'] !== undefined, 'dedup: merged event keeps richer DESCRIPTION');
  assert(result[0].fields['LOCATION'] !== undefined, 'dedup: merged event keeps richer LOCATION');
  assert(result[0].prefix === '✈️', 'dedup: merged event uses richer source prefix');
}

// deduplicateEvents — different events pass through
{
  const event1 = [
    'BEGIN:VEVENT',
    'DTSTART:20260315T100000Z',
    'SUMMARY:Flight to SFO',
    'UID:e1@test.com',
    'END:VEVENT',
  ].join('\r\n');

  const event2 = [
    'BEGIN:VEVENT',
    'DTSTART:20260316T140000Z',
    'SUMMARY:Dentist Appointment',
    'UID:e2@test.com',
    'END:VEVENT',
  ].join('\r\n');

  const tagged = [
    { raw: event1, feedId: 'tripit', prefix: '✈️' },
    { raw: event2, feedId: 'personal', prefix: '👤' },
  ];

  const result = deduplicateEvents(tagged);
  assert(result.length === 2, 'dedup: different events both pass through');
}

// deduplicateEvents — same-feed events never merged
{
  const event1 = [
    'BEGIN:VEVENT',
    'DTSTART:20260315T100000Z',
    'SUMMARY:Team Standup',
    'UID:e1@test.com',
    'END:VEVENT',
  ].join('\r\n');

  const event2 = [
    'BEGIN:VEVENT',
    'DTSTART:20260315T100000Z',
    'SUMMARY:Team Standup',
    'UID:e2@test.com',
    'END:VEVENT',
  ].join('\r\n');

  const tagged = [
    { raw: event1, feedId: 'work', prefix: '🏢' },
    { raw: event2, feedId: 'work', prefix: '🏢' },
  ];

  const result = deduplicateEvents(tagged);
  assert(result.length === 2, 'dedup: same-feed events never merged');
}

// deduplicateEvents — recurring events skipped
{
  const recurring = [
    'BEGIN:VEVENT',
    'DTSTART:20260315T100000Z',
    'SUMMARY:Weekly Standup',
    'RRULE:FREQ=WEEKLY;BYDAY=MO',
    'UID:r1@test.com',
    'END:VEVENT',
  ].join('\r\n');

  const similar = [
    'BEGIN:VEVENT',
    'DTSTART:20260315T100000Z',
    'SUMMARY:Weekly Standup',
    'UID:s1@test.com',
    'END:VEVENT',
  ].join('\r\n');

  const tagged = [
    { raw: recurring, feedId: 'work', prefix: '🏢' },
    { raw: similar, feedId: 'personal', prefix: '👤' },
  ];

  const result = deduplicateEvents(tagged);
  assert(result.length === 2, 'dedup: recurring events are skipped (not merged)');
}

// ── authenticateView tests ────────────────────────────────────────────────────

{
  const url1 = new URL('https://example.com/settings?token=abc123fulltoken&view=full');
  const result1 = authenticateView(url1, viewConfigs, viewTokens);
  assert(result1 !== null && result1.viewName === 'full', 'authenticateView: valid full view returns result');
  assert(result1 !== null && result1.view.calendarName === 'Adam (all)', 'authenticateView: returns correct view config');
}

{
  const url2 = new URL('https://example.com/settings?token=xyz789julietoken&view=julie');
  const result2 = authenticateView(url2, viewConfigs, viewTokens);
  assert(result2 !== null && result2.viewName === 'julie', 'authenticateView: valid julie view returns result');
}

{
  const url3 = new URL('https://example.com/settings?token=wrongtoken&view=full');
  assert(authenticateView(url3, viewConfigs, viewTokens) === null, 'authenticateView: wrong token returns null');
}

{
  const url4 = new URL('https://example.com/settings?token=abc123fulltoken&view=nonexistent');
  assert(authenticateView(url4, viewConfigs, viewTokens) === null, 'authenticateView: nonexistent view returns null');
}

{
  const url5 = new URL('https://example.com/settings?token=abc123fulltoken');
  const result5 = authenticateView(url5, viewConfigs, viewTokens);
  assert(result5 !== null && result5.viewName === 'full', 'authenticateView: defaults to full view when view param missing');
}

// ── KV fallback logic tests ───────────────────────────────────────────────────

{
  // When KV has an override, use it
  const kvResult = resolveEnabledFeeds('["gmail","tripit"]', views.julie.feeds);
  assert(kvResult.length === 2, 'KV fallback: uses KV override when present');
  assert(kvResult[0] === 'gmail' && kvResult[1] === 'tripit', 'KV fallback: returns correct KV feed IDs');
}

{
  // When KV is null, fall back to view config
  const fallbackResult = resolveEnabledFeeds(null, views.julie.feeds);
  assert(fallbackResult.length === 4, 'KV fallback: uses VIEWS feeds when KV is null');
  assert(JSON.stringify(fallbackResult) === JSON.stringify(views.julie.feeds), 'KV fallback: returns exact VIEWS feed array');
}

{
  // KV override filters feeds correctly
  const kvFeeds = resolveEnabledFeeds('["gmail"]', views.full.feeds);
  const filtered = filterFeeds(allFeeds, kvFeeds);
  assert(filtered.length === 1, 'KV fallback: KV override correctly limits feed list');
  assert(filtered[0].id === 'gmail', 'KV fallback: filtered feed matches KV selection');
}

// deduplicateEvents — cross-timezone dedup (UTC vs TZID)
{
  // TripIt sends UTC: 14:00Z, Outlook sends local: 10:00 America/Toronto (= 14:00 UTC)
  const utcEvent = [
    'BEGIN:VEVENT',
    'DTSTART:20260315T140000Z',
    'SUMMARY:Flight to SFO',
    'DESCRIPTION:Confirmation ABC123',
    'UID:tripit-tz@tripit.com',
    'END:VEVENT',
  ].join('\r\n');

  const tzEvent = [
    'BEGIN:VEVENT',
    'DTSTART;TZID=America/Toronto:20260315T100000',
    'SUMMARY:Flight to SFO',
    'UID:outlook-tz@outlook.com',
    'END:VEVENT',
  ].join('\r\n');

  const tagged = [
    { raw: utcEvent, feedId: 'tripit', prefix: '✈️' },
    { raw: tzEvent, feedId: 'personal', prefix: '👤' },
  ];

  const result = deduplicateEvents(tagged);
  assert(result.length === 1, 'dedup: UTC vs TZID same time merges to 1');
}

// deduplicateEvents — different times in different timezones should NOT merge
{
  const event1 = [
    'BEGIN:VEVENT',
    'DTSTART:20260315T100000Z',
    'SUMMARY:Team Standup',
    'UID:e1-tz@test.com',
    'END:VEVENT',
  ].join('\r\n');

  const event2 = [
    'BEGIN:VEVENT',
    'DTSTART;TZID=America/Toronto:20260315T100000',
    'SUMMARY:Team Standup',
    'UID:e2-tz@test.com',
    'END:VEVENT',
  ].join('\r\n');

  const tagged = [
    { raw: event1, feedId: 'work', prefix: '🏢' },
    { raw: event2, feedId: 'personal', prefix: '👤' },
  ];

  // 10:00 UTC vs 10:00 Toronto (14:00 UTC) = 4 hours apart, should NOT merge
  const result = deduplicateEvents(tagged);
  assert(result.length === 2, 'dedup: same local time different actual time stays separate');
}

// ── extractTimezones tests ─────────────────────────────────────────────────────

{
  const ical = `BEGIN:VCALENDAR
BEGIN:VTIMEZONE
TZID:America/Toronto
BEGIN:STANDARD
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
TZOFFSETFROM:-0400
TZOFFSETTO:-0500
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
TZOFFSETFROM:-0500
TZOFFSETTO:-0400
END:DAYLIGHT
END:VTIMEZONE
BEGIN:VEVENT
DTSTART;TZID=America/Toronto:20260315T100000
SUMMARY:Test
END:VEVENT
END:VCALENDAR`;

  const tzs = extractTimezones(ical);
  assert(tzs.length === 1, 'extractTimezones: extracts 1 VTIMEZONE block');
  assert(tzs[0].includes('TZID:America/Toronto'), 'extractTimezones: contains correct TZID');
  assert(tzs[0].startsWith('BEGIN:VTIMEZONE'), 'extractTimezones: starts with BEGIN');
  assert(tzs[0].endsWith('END:VTIMEZONE'), 'extractTimezones: ends with END');
}

{
  const ical = 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:No TZ\nEND:VEVENT\nEND:VCALENDAR';
  assert(extractTimezones(ical).length === 0, 'extractTimezones: returns empty for no timezones');
}

// ── loadFeedConfigs tests ──────────────────────────────────────────────────────

{
  const result = loadFeedConfigs(feedMeta, feedUrls);
  assert(result.length === 5, 'loadFeedConfigs: returns all 5 feeds');
  assert(result[0].id === 'gmail' && result[0].name === 'Gmail' && result[0].url === 'https://example.com/1' && result[0].prefix === '📧',
    'loadFeedConfigs: joins metadata with URL correctly');
}

{
  const result = loadFeedConfigs(feedMeta, {});
  assert(result.every(f => f.url === ''), 'loadFeedConfigs: missing URLs default to empty string');
}

{
  const result = loadFeedConfigs([], feedUrls);
  assert(result.length === 0, 'loadFeedConfigs: empty metadata returns empty array');
}

// ── loadViewConfig tests ───────────────────────────────────────────────────────

{
  const result = loadViewConfig('full', viewConfigs, viewTokens);
  assert(result !== null, 'loadViewConfig: returns config for valid view');
  assert(result.token === 'abc123fulltoken', 'loadViewConfig: includes token from secret');
  assert(result.calendarName === 'Adam (all)', 'loadViewConfig: includes calendarName from KV');
  assert(JSON.stringify(result.feeds) === JSON.stringify(['gmail', 'work', 'personal', 'tripit', 'f1']),
    'loadViewConfig: includes feeds from KV');
}

{
  const result = loadViewConfig('nonexistent', viewConfigs, viewTokens);
  assert(result === null, 'loadViewConfig: returns null for missing token');
}

{
  const result = loadViewConfig('full', {}, viewTokens);
  assert(result === null, 'loadViewConfig: returns null for missing view config');
}

// Summary
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('✅ All tests passed');
