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

function resolveView(views, viewName, token) {
  const dummyToken = 'x'.repeat(64);
  const expectedToken = views[viewName]?.token || dummyToken;
  const tokenValid = timingSafeEqual(token, expectedToken);
  const viewExists = viewName in views;
  return tokenValid && viewExists;
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

function parseEvent(tagged) {
  const lines = tagged.raw.split(/\r?\n/);
  const fields = {};
  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    let key = line.slice(0, colonIdx);
    const semiIdx = key.indexOf(';');
    if (semiIdx !== -1) key = key.slice(0, semiIdx);
    fields[key] = line.slice(colonIdx + 1);
  }
  return { lines, fields, feedId: tagged.feedId, prefix: tagged.prefix };
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

function parseICalDateTime(value) {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
}

function timesOverlap(a, b) {
  const aStart = parseICalDateTime(a.fields['DTSTART'] || '');
  const bStart = parseICalDateTime(b.fields['DTSTART'] || '');
  if (aStart === null || bStart === null) return false;
  return Math.abs(aStart - bStart) <= 5 * 60 * 1000;
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

const allFeeds = [
  { id: 'gmail',    name: 'Gmail',    url: 'https://example.com/1', prefix: '📧' },
  { id: 'work',     name: 'Work',     url: 'https://example.com/2', prefix: '🏢' },
  { id: 'personal', name: 'Personal', url: 'https://example.com/3', prefix: '👤' },
  { id: 'tripit',   name: 'TripIt',   url: 'https://example.com/4', prefix: '✈️' },
  { id: 'f1',       name: 'F1',       url: 'https://example.com/5', prefix: '🏎️' },
];

const views = {
  full: {
    token: 'abc123fulltoken',
    feeds: ['gmail', 'work', 'personal', 'tripit', 'f1'],
    calendarName: 'Adam (all)',
  },
  julie: {
    token: 'xyz789julietoken',
    feeds: ['gmail', 'personal', 'tripit', 'f1'],
    calendarName: "Adam's Schedule",
  },
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
assert(resolveView(views, 'full', 'abc123fulltoken') === true, 'Valid view + token passes');
assert(resolveView(views, 'julie', 'xyz789julietoken') === true, 'Julie view + token passes');
assert(resolveView(views, 'full', 'wrongtoken') === false, 'Wrong token rejects');
assert(resolveView(views, 'julie', 'abc123fulltoken') === false, 'Cross-view token rejects');
assert(resolveView(views, 'nonexistent', 'abc123fulltoken') === false, 'Nonexistent view rejects');
assert(resolveView(views, 'full', '') === false, 'Empty token rejects');

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
assert(parseICalDateTime('20260315T100000') === Date.UTC(2026, 2, 15, 10, 0, 0), 'parseICalDateTime: without Z');
assert(parseICalDateTime('invalid') === null, 'parseICalDateTime: invalid returns null');

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

// Summary
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('✅ All tests passed');
