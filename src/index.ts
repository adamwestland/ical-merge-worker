/**
 * iCal Merge Worker
 *
 * A Cloudflare Worker that fetches multiple iCal feeds in parallel,
 * merges all VEVENT components into a single VCALENDAR, and serves it
 * as a subscribable .ics endpoint.
 *
 * Features:
 *   - Named "views" so different people see different subsets of calendars
 *   - Per-view auth tokens (Julie gets a different token than you)
 *   - Timing-safe token comparison (prevents timing attacks)
 *   - Rate limiting via CF Cache (prevents brute-force token guessing)
 *   - Emoji prefixes per feed so the source is obvious at a glance
 *
 * Usage:
 *   GET /calendar.ics?token=JULIES_TOKEN&view=julie
 *   GET /calendar.ics?token=ADAMS_TOKEN&view=full
 *   GET /calendar.ics?token=ADAMS_TOKEN               (defaults to "full" view)
 *
 * Environment Variables (set in wrangler.toml or via `wrangler secret put`):
 *   CALENDAR_FEEDS    – JSON array of feed configs, each with a unique `id`
 *   VIEWS             – JSON object mapping view names to { token, feeds[], calendarName }
 *   CACHE_TTL_SECONDS – How long to cache the merged result (default: 900 = 15 min)
 */

export interface Env {
	CALENDAR_FEEDS: string;
	VIEWS: string;
	CACHE_TTL_SECONDS?: string;
}

interface FeedConfig {
	id: string;
	name: string;
	url: string;
	prefix?: string;
}

interface ViewConfig {
	token: string;
	feeds: string[];           // Array of feed IDs to include
	calendarName: string;
}

interface TaggedEvent {
	raw: string;        // VEVENT block (no prefix)
	feedId: string;
	prefix?: string;
}

interface ParsedEvent {
	lines: string[];                   // raw VEVENT lines
	fields: Record<string, string>;    // DTSTART, SUMMARY, DESCRIPTION, etc.
	feedId: string;
	prefix?: string;
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// Health check (no auth required)
		if (url.pathname === '/health') {
			return new Response('ok', { status: 200 });
		}

		// Only serve on /calendar.ics
		if (url.pathname !== '/calendar.ics') {
			return new Response('Not found. Use /calendar.ics', { status: 404 });
		}

		// ── Rate Limiting ─────────────────────────────────────────────────────
		// 30 requests per 60 seconds per IP — generous for calendar
		// polling, brutal for brute-force guessing a 256-bit token.
		const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
		const rateLimitResult = await checkRateLimit(clientIP, 30, 60);
		if (!rateLimitResult.allowed) {
			return new Response('Too many requests', {
				status: 429,
				headers: { 'Retry-After': '60' },
			});
		}

		// ── Parse views & feeds ───────────────────────────────────────────────
		const allFeeds: FeedConfig[] = JSON.parse(env.CALENDAR_FEEDS);
		const views: Record<string, ViewConfig> = JSON.parse(env.VIEWS);

		// ── Resolve view ──────────────────────────────────────────────────────
		const viewName = url.searchParams.get('view') || 'full';
		const token = url.searchParams.get('token') || '';

		// ── Auth ──────────────────────────────────────────────────────────────
		// Try to authenticate against the requested view.
		// If the view doesn't exist, compare against a dummy token to avoid
		// leaking which view names are valid via response timing.
		const dummyToken = 'x'.repeat(64);
		const expectedToken = views[viewName]?.token || dummyToken;
		const tokenValid = timingSafeEqual(token, expectedToken);
		const viewExists = viewName in views;

		if (!tokenValid || !viewExists) {
			return new Response('Unauthorized', { status: 401 });
		}

		const view = views[viewName];

		// ── Cache layer ───────────────────────────────────────────────────────
		// Cache key includes the full URL (with view param) so views cache separately
		const cacheKey = new Request(url.toString(), request);
		const cache = caches.default;
		const cachedResponse = await cache.match(cacheKey);
		if (cachedResponse) {
			return cachedResponse;
		}

		// ── Filter feeds for this view ────────────────────────────────────────
		const feedIds = new Set(view.feeds);
		const viewFeeds = allFeeds.filter(f => feedIds.has(f.id));

		if (viewFeeds.length === 0) {
			return new Response('No feeds configured for this view', { status: 500 });
		}

		// ── Fetch & merge ─────────────────────────────────────────────────────
		const ttl = parseInt(env.CACHE_TTL_SECONDS || '900', 10);
		const mergedIcal = await mergeFeeds(viewFeeds, view.calendarName);

		const response = new Response(mergedIcal, {
			status: 200,
			headers: {
				'Content-Type': 'text/calendar; charset=utf-8',
				'Content-Disposition': `inline; filename="${viewName}.ics"`,
				'Cache-Control': `public, max-age=${ttl}`,
			},
		});

		ctx.waitUntil(cache.put(cacheKey, response.clone()));

		return response;
	},
};

// ─── Security Helpers ─────────────────────────────────────────────────────────

/**
 * Timing-safe string comparison.
 * Prevents attackers from guessing the token one character at a time
 * by measuring response time differences.
 */
function timingSafeEqual(a: string, b: string): boolean {
	const encoder = new TextEncoder();
	const aBytes = encoder.encode(a);
	const bBytes = encoder.encode(b);

	// If lengths differ, compare a against itself to burn the same cycles,
	// but remember we need to return false.
	const lengthMismatch = aBytes.length !== bBytes.length;
	const compareTarget = lengthMismatch ? aBytes : bBytes;

	let mismatch = lengthMismatch ? 1 : 0;
	for (let i = 0; i < aBytes.length; i++) {
		mismatch |= aBytes[i] ^ compareTarget[i];
	}
	return mismatch === 0;
}

/**
 * Simple rate limiter using CF Cache API.
 * Tracks request count per IP in a sliding window.
 */
async function checkRateLimit(
	key: string,
	maxRequests: number,
	windowSeconds: number
): Promise<{ allowed: boolean }> {
	const cache = caches.default;
	const cacheUrl = `https://rate-limit.internal/${encodeURIComponent(key)}`;
	const cacheReq = new Request(cacheUrl);

	const existing = await cache.match(cacheReq);
	let count = 0;

	if (existing) {
		count = parseInt(await existing.text(), 10) || 0;
	}

	if (count >= maxRequests) {
		return { allowed: false };
	}

	const newResponse = new Response(String(count + 1), {
		headers: { 'Cache-Control': `public, max-age=${windowSeconds}` },
	});
	cache.put(cacheReq, newResponse); // fire and forget

	return { allowed: true };
}

// ─── Core Merge Logic ─────────────────────────────────────────────────────────

async function mergeFeeds(feeds: FeedConfig[], calendarName: string): Promise<string> {
	const results = await Promise.allSettled(
		feeds.map(feed => fetchFeed(feed))
	);

	const taggedEvents: TaggedEvent[] = [];

	for (let i = 0; i < results.length; i++) {
		const result = results[i];
		const feed = feeds[i];

		if (result.status === 'fulfilled') {
			const events = extractEvents(result.value);
			for (const raw of events) {
				taggedEvents.push({ raw, feedId: feed.id, prefix: feed.prefix });
			}
			console.log(`✓ ${feed.name}: ${events.length} events`);
		} else {
			console.error(`✗ ${feed.name}: ${result.reason}`);
		}
	}

	const deduped = deduplicateEvents(taggedEvents);
	const serialized = deduped.map(e => serializeEvent(e));

	return buildCalendar(calendarName, serialized);
}

async function fetchFeed(feed: FeedConfig): Promise<string> {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 15_000);

	try {
		const response = await fetch(feed.url, {
			signal: controller.signal,
			headers: {
				'User-Agent': 'iCalMerge/1.0 (Cloudflare Worker)',
				'Accept': 'text/calendar, text/plain, */*',
			},
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status} from ${feed.name}`);
		}

		return await response.text();
	} finally {
		clearTimeout(timeoutId);
	}
}

// ─── iCal Parsing ─────────────────────────────────────────────────────────────

function extractEvents(icalText: string, prefix?: string): string[] {
	const unfolded = icalText.replace(/\r?\n[ \t]/g, '');
	const events: string[] = [];
	const lines = unfolded.split(/\r?\n/);

	let inEvent = false;
	let eventLines: string[] = [];

	for (const line of lines) {
		if (line === 'BEGIN:VEVENT') {
			inEvent = true;
			eventLines = [line];
		} else if (line === 'END:VEVENT' && inEvent) {
			eventLines.push(line);
			inEvent = false;

			if (prefix) {
				events.push(prefixSummary(eventLines, prefix).join('\r\n'));
			} else {
				events.push(eventLines.join('\r\n'));
			}
		} else if (inEvent) {
			eventLines.push(line);
		}
	}

	return events;
}

function prefixSummary(lines: string[], prefix: string): string[] {
	return lines.map(line => {
		if (line.startsWith('SUMMARY:')) {
			return `SUMMARY:${prefix} ${line.slice(8)}`;
		}
		return line;
	});
}

// ─── Deduplication ────────────────────────────────────────────────────────────

function parseEvent(tagged: TaggedEvent): ParsedEvent {
	const lines = tagged.raw.split(/\r?\n/);
	const fields: Record<string, string> = {};
	for (const line of lines) {
		const colonIdx = line.indexOf(':');
		if (colonIdx === -1) continue;
		let key = line.slice(0, colonIdx);
		// Strip parameters (e.g. DTSTART;TZID=... → DTSTART)
		const semiIdx = key.indexOf(';');
		if (semiIdx !== -1) key = key.slice(0, semiIdx);
		fields[key] = line.slice(colonIdx + 1);
	}
	return { lines, fields, feedId: tagged.feedId, prefix: tagged.prefix };
}

function normalizeTitle(summary: string): string {
	return summary
		.toLowerCase()
		.replace(/[^\w\s]/g, '')  // strip punctuation
		.replace(/\b(to|from|the|a|an)\b/g, '') // filler words
		.replace(/\s+/g, ' ')
		.trim();
}

function diceCoefficient(a: string, b: string): number {
	if (a === b) return 1.0;
	if (a.length < 2 || b.length < 2) return 0.0;

	const bigrams = (s: string): Map<string, number> => {
		const map = new Map<string, number>();
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

function titlesMatch(a: string, b: string): boolean {
	const na = normalizeTitle(a);
	const nb = normalizeTitle(b);

	if (na === nb) return true;
	if (na.includes(nb) || nb.includes(na)) return true;
	return diceCoefficient(na, nb) >= 0.75;
}

function parseICalDateTime(value: string): number | null {
	// Handles: 20260315T100000Z or 20260315T100000
	const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
	if (!match) return null;
	const [, y, mo, d, h, mi, s] = match;
	return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
}

function timesOverlap(a: ParsedEvent, b: ParsedEvent): boolean {
	const aStart = parseICalDateTime(a.fields['DTSTART'] || '');
	const bStart = parseICalDateTime(b.fields['DTSTART'] || '');
	if (aStart === null || bStart === null) return false;
	return Math.abs(aStart - bStart) <= 5 * 60 * 1000; // 5 minutes
}

function eventRichness(parsed: ParsedEvent): number {
	let score = 0;
	const richFields = ['DESCRIPTION', 'LOCATION', 'GEO', 'URL', 'ATTENDEE', 'ORGANIZER'];
	for (const f of richFields) {
		if (parsed.fields[f]) score++;
	}
	score += (parsed.fields['DESCRIPTION'] || '').length;
	return score;
}

function mergeEvents(a: ParsedEvent, b: ParsedEvent): ParsedEvent {
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
		// Skip UID/DTSTAMP from secondary, and anything primary already has
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

function deduplicateEvents(tagged: TaggedEvent[]): ParsedEvent[] {
	const parsed = tagged.map(t => parseEvent(t));
	const merged = new Array(parsed.length).fill(false); // track which indices were merged away

	for (let i = 0; i < parsed.length; i++) {
		if (merged[i]) continue;
		// Skip recurring events
		if (parsed[i].fields['RRULE']) continue;

		for (let j = i + 1; j < parsed.length; j++) {
			if (merged[j]) continue;
			if (parsed[j].fields['RRULE']) continue;
			// Never dedup events from the same feed
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

function serializeEvent(parsed: ParsedEvent): string {
	const lines = parsed.prefix ? prefixSummary(parsed.lines, parsed.prefix) : parsed.lines;
	return lines.join('\r\n');
}

function buildCalendar(name: string, events: string[]): string {
	const header = [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//iCalMerge//Cloudflare Worker//EN',
		`X-WR-CALNAME:${name}`,
		'CALSCALE:GREGORIAN',
		'METHOD:PUBLISH',
		'X-PUBLISHED-TTL:PT15M',
		'REFRESH-INTERVAL;VALUE=DURATION:PT15M',
	];

	const footer = ['END:VCALENDAR'];

	return [...header, ...events, ...footer].join('\r\n');
}
