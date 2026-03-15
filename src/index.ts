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
 *   - Web UI for toggling feeds on/off per view
 *
 * Usage:
 *   GET /calendar.ics?token=JULIES_TOKEN&view=julie
 *   GET /calendar.ics?token=ADAMS_TOKEN&view=full
 *   GET /calendar.ics?token=ADAMS_TOKEN               (defaults to "full" view)
 *   GET /settings?token=X&view=julie                   (feed toggle UI)
 *
 * Environment Variables (set in wrangler.toml or via `wrangler secret put`):
 *   FEED_URLS         – JSON object mapping feed id to URL: { "gmail": "https://...", ... }
 *   VIEW_TOKENS       – JSON object mapping view name to token: { "full": "abc...", ... }
 *   CACHE_TTL_SECONDS – How long to cache the merged result (default: 900 = 15 min)
 *   SETTINGS          – KV namespace for feed metadata, view config, and per-view overrides
 *                       KV keys: config:feeds, config:views, view:<name>:feeds
 */

export interface Env {
	FEED_URLS: string;
	VIEW_TOKENS: string;
	CACHE_TTL_SECONDS?: string;
	SETTINGS: KVNamespace;
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

		// ── Rate Limiting ─────────────────────────────────────────────────────
		const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
		const rateLimitResult = await checkRateLimit(clientIP, 30, 60);
		if (!rateLimitResult.allowed) {
			return new Response('Too many requests', {
				status: 429,
				headers: { 'Retry-After': '60' },
			});
		}

		// ── Route ─────────────────────────────────────────────────────────────
		switch (url.pathname) {
			case '/calendar.ics':
				return handleCalendar(request, url, env, ctx);
			case '/settings':
				return handleSettingsPage(url, env);
			case '/api/feeds':
				return handleFeedsApi(request, url, env);
			default:
				return new Response('Not found', { status: 404 });
		}
	},
};

// ─── Config Loaders ───────────────────────────────────────────────────────────

async function loadFeedConfigs(env: Env): Promise<FeedConfig[]> {
	const feedsJson = await env.SETTINGS.get('config:feeds');
	if (!feedsJson) return [];
	const feedMeta: Array<{ id: string; name: string; prefix?: string }> = JSON.parse(feedsJson);
	const feedUrls: Record<string, string> = JSON.parse(env.FEED_URLS);

	return feedMeta.map(meta => ({
		id: meta.id,
		name: meta.name,
		url: feedUrls[meta.id] || '',
		prefix: meta.prefix,
	}));
}

async function loadViewConfig(viewName: string, env: Env): Promise<ViewConfig | null> {
	const viewTokens: Record<string, string> = JSON.parse(env.VIEW_TOKENS);
	const token = viewTokens[viewName];
	if (!token) return null;

	const viewsJson = await env.SETTINGS.get('config:views');
	if (!viewsJson) return null;
	const views: Record<string, { feeds: string[]; calendarName: string }> = JSON.parse(viewsJson);
	const config = views[viewName];
	if (!config) return null;

	return { token, feeds: config.feeds, calendarName: config.calendarName };
}

// ─── Auth Helper ──────────────────────────────────────────────────────────────

async function authenticateView(
	url: URL,
	env: Env
): Promise<{ view: ViewConfig; viewName: string } | null> {
	const viewTokens: Record<string, string> = JSON.parse(env.VIEW_TOKENS);
	const viewName = url.searchParams.get('view') || 'full';
	const token = url.searchParams.get('token') || '';

	const dummyToken = 'x'.repeat(64);
	const expectedToken = viewTokens[viewName] || dummyToken;
	const tokenValid = timingSafeEqual(token, expectedToken);
	const tokenExists = viewName in viewTokens;

	if (!tokenValid || !tokenExists) {
		return null;
	}

	const view = await loadViewConfig(viewName, env);
	if (!view) return null;

	return { view, viewName };
}

// ─── Calendar Route ───────────────────────────────────────────────────────────

async function handleCalendar(
	request: Request,
	url: URL,
	env: Env,
	ctx: ExecutionContext
): Promise<Response> {
	const auth = await authenticateView(url, env);
	if (!auth) {
		return new Response('Unauthorized', { status: 401 });
	}

	const { view, viewName } = auth;

	// ── Cache layer ───────────────────────────────────────────────────────
	const cacheKey = new Request(url.toString(), request);
	const cache = caches.default;
	const cachedResponse = await cache.match(cacheKey);
	if (cachedResponse) {
		return cachedResponse;
	}

	// ── Filter feeds for this view (KV override → config fallback) ────────
	const allFeeds = await loadFeedConfigs(env);
	const kvFeeds = await env.SETTINGS.get(`view:${viewName}:feeds`);
	const feedIds = new Set(kvFeeds ? JSON.parse(kvFeeds) : view.feeds);
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
}

// ─── Settings Page ────────────────────────────────────────────────────────────

async function handleSettingsPage(url: URL, env: Env): Promise<Response> {
	const auth = await authenticateView(url, env);
	if (!auth) {
		return new Response('Unauthorized', { status: 401 });
	}

	const { view, viewName } = auth;
	const token = url.searchParams.get('token') || '';

	const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Feed Settings – ${escapeHtml(view.calendarName)}</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#fff;--fg:#111;--muted:#666;--border:#e0e0e0;--card:#f8f8f8;--accent:#2563eb;--accent-fg:#fff;--success:#16a34a;--error:#dc2626;--toggle-bg:#ccc;--toggle-on:#2563eb}
@media(prefers-color-scheme:dark){:root{--bg:#111;--fg:#f0f0f0;--muted:#999;--border:#333;--card:#1a1a1a;--accent:#3b82f6;--toggle-bg:#444;--toggle-on:#3b82f6}}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--fg);max-width:480px;margin:0 auto;padding:16px 16px 100px}
h1{font-size:1.25rem;margin-bottom:2px}
.subtitle{color:var(--muted);font-size:.875rem;margin-bottom:24px}
.feed-list{list-style:none}
.feed-item{display:flex;align-items:center;justify-content:space-between;padding:14px 0;border-bottom:1px solid var(--border)}
.feed-info{display:flex;align-items:center;gap:10px}
.feed-prefix{font-size:1.25rem;width:28px;text-align:center}
.feed-name{font-size:1rem}
.toggle{position:relative;width:52px;height:30px;flex-shrink:0}
.toggle input{opacity:0;width:0;height:0}
.toggle .slider{position:absolute;inset:0;background:var(--toggle-bg);border-radius:15px;cursor:pointer;transition:background .2s}
.toggle .slider::before{content:'';position:absolute;width:24px;height:24px;left:3px;top:3px;background:#fff;border-radius:50%;transition:transform .2s;box-shadow:0 1px 3px rgba(0,0,0,.2)}
.toggle input:checked+.slider{background:var(--toggle-on)}
.toggle input:checked+.slider::before{transform:translateX(22px)}
.save-bar{position:fixed;bottom:0;left:0;right:0;padding:16px;background:var(--bg);border-top:1px solid var(--border)}
.save-bar-inner{max-width:480px;margin:0 auto}
.save-btn{width:100%;padding:14px;font-size:1rem;font-weight:600;border:none;border-radius:10px;background:var(--accent);color:var(--accent-fg);cursor:pointer;min-height:48px}
.save-btn:disabled{opacity:.5;cursor:not-allowed}
.toast{position:fixed;top:16px;left:50%;transform:translateX(-50%);padding:10px 20px;border-radius:8px;font-size:.875rem;font-weight:500;opacity:0;transition:opacity .3s;pointer-events:none;z-index:10}
.toast.success{background:var(--success);color:#fff}
.toast.error{background:var(--error);color:#fff}
.toast.show{opacity:1}
.loading{text-align:center;padding:40px;color:var(--muted)}
</style>
</head>
<body>
<h1>${escapeHtml(viewName)}</h1>
<p class="subtitle">${escapeHtml(view.calendarName)}</p>
<div id="content"><p class="loading">Loading feeds…</p></div>
<div class="save-bar"><div class="save-bar-inner">
<button class="save-btn" id="saveBtn" disabled>Save</button>
</div></div>
<div class="toast" id="toast"></div>
<script>
const TOKEN = ${JSON.stringify(token)};
const VIEW = ${JSON.stringify(viewName)};
const qs = 'token=' + encodeURIComponent(TOKEN) + '&view=' + encodeURIComponent(VIEW);
let feeds = [];

async function load() {
  try {
    const res = await fetch('/api/feeds?' + qs);
    if (!res.ok) throw new Error('Failed to load');
    const data = await res.json();
    feeds = data.feeds;
    render(data.feeds, data.enabled);
  } catch (e) {
    document.getElementById('content').innerHTML = '<p class="loading">Failed to load feeds.</p>';
  }
}

function render(feeds, enabled) {
  const set = new Set(enabled);
  let html = '<ul class="feed-list">';
  for (const f of feeds) {
    html += '<li class="feed-item">'
      + '<div class="feed-info">'
      + '<span class="feed-prefix">' + esc(f.prefix || '') + '</span>'
      + '<span class="feed-name">' + esc(f.name) + '</span>'
      + '</div>'
      + '<label class="toggle">'
      + '<input type="checkbox" data-id="' + esc(f.id) + '"' + (set.has(f.id) ? ' checked' : '') + '>'
      + '<span class="slider"></span>'
      + '</label></li>';
  }
  html += '</ul>';
  document.getElementById('content').innerHTML = html;
  document.getElementById('saveBtn').disabled = false;
  document.querySelectorAll('.toggle input').forEach(cb => cb.addEventListener('change', validate));
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function getEnabled() {
  return [...document.querySelectorAll('.toggle input:checked')].map(cb => cb.dataset.id);
}

function validate() {
  const btn = document.getElementById('saveBtn');
  btn.disabled = getEnabled().length === 0;
}

async function save() {
  const btn = document.getElementById('saveBtn');
  const enabled = getEnabled();
  if (enabled.length === 0) return;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const res = await fetch('/api/feeds?' + qs, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feeds: enabled })
    });
    if (!res.ok) throw new Error('Save failed');
    showToast('Saved! Changes take effect within 15 minutes.', 'success');
  } catch (e) {
    showToast('Failed to save. Try again.', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save';
  }
}

function showToast(msg, type) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast ' + type + ' show';
  setTimeout(() => t.classList.remove('show'), 3000);
}

document.getElementById('saveBtn').addEventListener('click', save);
load();
</script>
</body>
</html>`;

	return new Response(html, {
		headers: { 'Content-Type': 'text/html; charset=utf-8' },
	});
}

function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Feeds API ────────────────────────────────────────────────────────────────

async function handleFeedsApi(request: Request, url: URL, env: Env): Promise<Response> {
	const auth = await authenticateView(url, env);
	if (!auth) {
		return new Response('Unauthorized', { status: 401 });
	}

	const { view, viewName } = auth;
	const allFeeds = await loadFeedConfigs(env);

	if (request.method === 'GET') {
		const kvFeeds = await env.SETTINGS.get(`view:${viewName}:feeds`);
		const enabledIds: string[] = kvFeeds ? JSON.parse(kvFeeds) : view.feeds;

		const feeds = allFeeds.map(f => ({
			id: f.id,
			name: f.name,
			prefix: f.prefix || '',
		}));

		return Response.json({ feeds, enabled: enabledIds });
	}

	if (request.method === 'PUT') {
		let body: { feeds?: unknown };
		try {
			body = await request.json();
		} catch {
			return Response.json({ error: 'Invalid JSON' }, { status: 400 });
		}

		if (!Array.isArray(body.feeds) || body.feeds.length === 0) {
			return Response.json({ error: 'feeds must be a non-empty array of strings' }, { status: 400 });
		}

		const validIds = new Set(allFeeds.map(f => f.id));
		const requestedFeeds: string[] = [];
		for (const id of body.feeds) {
			if (typeof id !== 'string' || !validIds.has(id)) {
				return Response.json({ error: `Invalid feed ID: ${id}` }, { status: 400 });
			}
			requestedFeeds.push(id);
		}

		await env.SETTINGS.put(`view:${viewName}:feeds`, JSON.stringify(requestedFeeds));

		return Response.json({ ok: true, feeds: requestedFeeds });
	}

	return new Response('Method not allowed', { status: 405 });
}

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
	const seenTZIDs = new Set<string>();
	const timezones: string[] = [];

	for (let i = 0; i < results.length; i++) {
		const result = results[i];
		const feed = feeds[i];

		if (result.status === 'fulfilled') {
			const icalText = result.value;
			const events = extractEvents(icalText);
			for (const raw of events) {
				taggedEvents.push({ raw, feedId: feed.id, prefix: feed.prefix });
			}
			// Collect VTIMEZONE blocks, deduplicated by TZID
			for (const tz of extractTimezones(icalText)) {
				const tzidMatch = tz.match(/TZID:(.+)/);
				const tzid = tzidMatch ? tzidMatch[1] : tz;
				if (!seenTZIDs.has(tzid)) {
					seenTZIDs.add(tzid);
					timezones.push(tz);
				}
			}
			console.log(`✓ ${feed.name}: ${events.length} events`);
		} else {
			console.error(`✗ ${feed.name}: ${result.reason}`);
		}
	}

	const deduped = deduplicateEvents(taggedEvents);
	const serialized = deduped.map(e => serializeEvent(e));

	return buildCalendar(calendarName, timezones, serialized);
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

function extractTimezones(icalText: string): string[] {
	const unfolded = icalText.replace(/\r?\n[ \t]/g, '');
	const timezones: string[] = [];
	const lines = unfolded.split(/\r?\n/);

	let inTZ = false;
	let tzLines: string[] = [];

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

function parseICalDateTime(value: string, tzid?: string): number | null {
	// All-day: 20260315
	const dateOnly = value.match(/^(\d{4})(\d{2})(\d{2})$/);
	if (dateOnly) {
		const [, y, mo, d] = dateOnly;
		return Date.UTC(+y, +mo - 1, +d);
	}

	// DateTime with Z suffix — already UTC
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
		// No timezone info — treat as UTC (best effort)
		return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
	}

	return localTimeToUTC(+y, +mo - 1, +d, +h, +mi, +s, tzid);
}

function localTimeToUTC(
	y: number, mo: number, d: number, h: number, mi: number, s: number, tzid: string
): number {
	// Treat the local time as if it were UTC, then compute the offset
	const guessUTC = Date.UTC(y, mo, d, h, mi, s);
	const localStr = new Date(guessUTC).toLocaleString('sv-SE', { timeZone: tzid });
	// sv-SE format: "2026-03-15 06:00:00"
	const [datePart, timePart] = localStr.split(' ');
	const [ly, lmo, ld] = datePart.split('-').map(Number);
	const [lh, lmi, ls] = timePart.split(':').map(Number);
	const localAsUTC = Date.UTC(ly, lmo - 1, ld, lh, lmi, ls);
	return guessUTC - (localAsUTC - guessUTC);
}

function timesOverlap(a: ParsedEvent, b: ParsedEvent): boolean {
	const aStart = parseICalDateTime(a.fields['DTSTART'] || '', a.fields['DTSTART_TZID']);
	const bStart = parseICalDateTime(b.fields['DTSTART'] || '', b.fields['DTSTART_TZID']);
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

function buildCalendar(name: string, timezones: string[], events: string[]): string {
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

	return [...header, ...timezones, ...events, ...footer].join('\r\n');
}
