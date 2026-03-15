# iCal Merge Worker

A Cloudflare Worker that fetches multiple iCal/ICS calendar feeds in parallel, merges all events into a single `VCALENDAR`, and serves it as one subscribable `.ics` endpoint. Supports named "views" so different people can subscribe to different subsets of your calendars with separate auth tokens.

## Why

Calendar apps don't let you merge multiple feeds into one subscription. If you have calendars spread across Google, M365, booking systems, and subscription feeds, anyone who wants to see your availability needs to subscribe to each one separately — or you can run this worker and give them a single URL.

## Architecture

```
┌─────────────────────┐
│  Google Calendar     │──┐
│  M365 Work           │──┤
│  M365 Personal       │──┤     ┌──────────────────┐     ┌─────────────────┐
│  TripIt              │──┼────▶│  CF Worker        │────▶│  /calendar.ics  │
│  Booking systems     │──┤     │  Fetch → Merge    │     │  Per-view auth  │
│  Any .ics feed       │──┘     │  Cache 15 min     │     └─────────────────┘
└─────────────────────┘         └──────────────────┘
```

## Features

- **Named views** — different people see different calendar subsets
- **Per-view auth tokens** — each view has its own 256-bit token
- **Parallel fetching** — all feeds fetched concurrently with 15s timeouts
- **Emoji prefixes** — each feed gets an emoji on event titles so the source is obvious at a glance
- **Timing-safe token comparison** — prevents timing attacks
- **Rate limiting** — 30 req/min per IP via CF Cache
- **Graceful degradation** — if one feed is down, the others still merge
- **Zero runtime dependencies** — pure TypeScript on Cloudflare Workers
- **Free** — runs well within Cloudflare Workers' free tier (100k requests/day)

## Quick Start

The easiest way to get this running is to point your AI coding agent (Claude Code, Cursor, etc.) at this repo and tell it:

> Install wrangler, set up my Cloudflare account, configure my calendar feeds, and deploy this worker.

Or do it manually:

### 1. Clone and install

```bash
git clone https://github.com/adamwestland/ical-merge-worker.git
cd ical-merge-worker
npm install
```

### 2. Sign up for Cloudflare (free)

If you don't have a Cloudflare account:
1. Sign up at [dash.cloudflare.com](https://dash.cloudflare.com)
2. The Workers free tier gives you 100k requests/day — more than enough

### 3. Authenticate

```bash
npx wrangler login    # Opens browser for Cloudflare OAuth
npx wrangler whoami   # Verify it worked
```

### 4. Configure your feeds

Create a JSON array of your calendar feeds:

```json
[
  {
    "id": "google",
    "name": "Google Calendar",
    "url": "https://calendar.google.com/calendar/ical/YOU/basic.ics",
    "prefix": "📧"
  },
  {
    "id": "work",
    "name": "Work",
    "url": "https://outlook.office365.com/owa/calendar/.../calendar.ics",
    "prefix": "🏢"
  }
]
```

Each feed needs:
- **`id`** — unique short name (referenced by views)
- **`name`** — display name (for logs only)
- **`url`** — the iCal feed URL
- **`prefix`** — (optional) emoji prepended to event titles

### 5. Configure views

Generate tokens and define who sees what:

```bash
# Generate a token
openssl rand -hex 32
```

```json
{
  "full": {
    "token": "PASTE_GENERATED_TOKEN_HERE",
    "feeds": ["google", "work"],
    "calendarName": "My Calendar"
  },
  "partner": {
    "token": "PASTE_ANOTHER_TOKEN_HERE",
    "feeds": ["google"],
    "calendarName": "My Schedule"
  }
}
```

### 6. Upload secrets and deploy

```bash
# Store feeds (paste your JSON when prompted)
npx wrangler secret put CALENDAR_FEEDS

# Store views (paste your JSON when prompted)
npx wrangler secret put VIEWS

# Deploy
npx wrangler deploy
```

### 7. Test

```bash
# Health check
curl https://ical-merge.YOUR_SUBDOMAIN.workers.dev/health
# → 200 ok

# Without token
curl https://ical-merge.YOUR_SUBDOMAIN.workers.dev/calendar.ics
# → 401 Unauthorized

# With token
curl "https://ical-merge.YOUR_SUBDOMAIN.workers.dev/calendar.ics?token=YOUR_TOKEN&view=full"
# → valid .ics data
```

### 8. Subscribe

Add the URL to any calendar app:
- **Google Calendar:** Other calendars (+) → From URL → paste the full URL with token
- **Apple Calendar:** File → New Calendar Subscription → paste URL
- **Outlook:** Add calendar → Subscribe from web → paste URL

## Custom Domain (Optional)

To serve from your own domain instead of `workers.dev`, add a route to `wrangler.toml`:

```toml
routes = [
  { pattern = "cal.yourdomain.com", custom_domain = true }
]
```

Your domain must be added as a zone in your Cloudflare account. Cloudflare handles the DNS record automatically.

## Finding Your Feed URLs

### Google Calendar
[Google Calendar Settings](https://calendar.google.com/calendar/r/settings) → your calendar → **"Secret address in iCal format"**

### M365 (Work or Personal)
Outlook web → Settings → Calendar → Shared calendars → **Publish a calendar** → "Can view all details" → copy the **ICS** link. Note: org admin must have calendar publishing enabled for work accounts.

### TripIt
TripIt → Settings → **iCal Feeds** → copy the private feed URL

### JaneApp / Other Booking Systems
Most booking platforms provide an iCal subscription URL in your account settings.

### Apple Calendar Subscriptions
Right-click the subscription calendar in Calendar.app → Get Info → copy the URL.

## Configuration Reference

### wrangler.toml

| Variable | Description | Default |
|----------|-------------|---------|
| `CACHE_TTL_SECONDS` | How long the merged result is cached | `900` (15 min) |

### Endpoints

| Path | Auth | Description |
|------|------|-------------|
| `/health` | None | Returns `200 ok` |
| `/calendar.ics?token=...&view=...` | Token required | Merged iCal feed |

The `view` parameter defaults to `full` if omitted.

## Development

```bash
npm test              # Run all 21 unit tests
npx wrangler dev      # Local dev server
npx wrangler tail     # Stream production logs
```

## Google Calendar Refresh Behavior

Google Calendar refreshes subscribed feeds on its own schedule — typically **every 12-24 hours**. The worker sets `REFRESH-INTERVAL:PT15M` as a hint, but Google may ignore it. To force a refresh: remove and re-add the subscription.

## Troubleshooting

**401 Unauthorized** — check your `?token=` and `?view=` parameters match a configured view

**Missing events from one feed** — run `npx wrangler tail` to see per-feed success/failure logs, or test the feed URL directly with `curl`

**Google Calendar not updating** — Google's refresh cycle is 12-24h; remove and re-add the subscription to force it

**M365 "Publish" greyed out** — your M365 admin needs to enable external calendar sharing in Exchange admin center

## License

MIT
