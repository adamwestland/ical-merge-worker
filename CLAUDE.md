# CLAUDE.md

## Project Overview

Cloudflare Worker that merges multiple iCal feeds into one subscribable `.ics` endpoint with per-view auth tokens.

## Tech Stack

- **Runtime:** Cloudflare Workers
- **Language:** TypeScript (single file: `src/index.ts`)
- **Build/Deploy:** Wrangler v4
- **Tests:** Plain Node.js (no test framework) — `test/test.mjs`

## Commands

```bash
npm test              # Run all unit tests
npx wrangler dev      # Local dev server
npx wrangler deploy   # Deploy to Cloudflare
npx wrangler tail     # Stream production logs
```

## Project Structure

```
src/index.ts       # All worker code (entry point, auth, parsing, merging)
test/test.mjs      # Unit tests (mirrors core functions from index.ts)
wrangler.toml      # Cloudflare config (non-secret vars, route, compat date)
```

## Key Design Decisions

- **Single file architecture** — the entire worker is `src/index.ts`. No need to split unless it grows significantly.
- **Secrets not in source** — `FEED_URLS` (feed URLs) and `VIEW_TOKENS` (auth tokens) are Cloudflare encrypted secrets, set via `npx wrangler secret put`. Non-secret config (names, prefixes, feed assignments, calendar names) lives in the `SETTINGS` KV namespace under `config:feeds` and `config:views` keys. Never commit real URLs or tokens.
- **Tests duplicate core functions** — `test/test.mjs` copies `extractEvents`, `timingSafeEqual`, etc. from the source since the worker code can't be directly imported into Node.js. When changing core logic, update both files.
- **No runtime dependencies** — the worker uses only Web APIs available in the Workers runtime.

## Secrets Management

```bash
npx wrangler secret put FEED_URLS      # JSON object: { "gmail": "https://...", ... }
npx wrangler secret put VIEW_TOKENS    # JSON object: { "full": "abc...", "julie": "xyz..." }
```

Non-secret config lives in the `SETTINGS` KV namespace:
- `config:feeds` — `[{ "id": "gmail", "name": "Gmail", "prefix": "📧" }, ...]`
- `config:views` — `{ "full": { "feeds": ["gmail", ...], "calendarName": "..." }, ... }`

Tokens are generated with `openssl rand -hex 32`.

## Gotchas

- The test file is plain `.mjs` (not TypeScript) and runs with `node` directly — no compilation step needed.
- When modifying iCal parsing logic in `src/index.ts`, remember to update the mirrored functions in `test/test.mjs`.
- Custom domain routing is configured in `wrangler.toml` — Cloudflare manages the DNS record automatically.
