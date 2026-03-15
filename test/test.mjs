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

// Summary
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('✅ All tests passed');
