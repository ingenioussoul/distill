# Distill — Claude Code context

An Ingenious Soul product. See. Think. Build. Repeat.

Live at: https://distill.ingenioussoul.com  
App: https://distill.ingenioussoul.com/app  
Deployed: Railway — project `attractive-energy`, service `distill`  
Repo: https://github.com/ingenioussoul/distill  
Deploy command: `railway up --message "description"`

---

## What it is

Distill turns friction observations into buildable product ideas. Builders capture what catches their eye (photo, voice, or text), AI groups captures into patterns, and when a pattern recurs enough it graduates into a pressure test, a brief, and launch copy — ending with a prompt ready to hand to Claude Code or scaffold on Ingenious Stack.

**The loop:** See → Think → Build → Repeat

---

## Stack

- **Runtime:** Node.js, Express 5 (`/*path` wildcard syntax required)
- **Auth:** Better Auth with magic link via Resend
- **Database:** Drizzle ORM + Neon (PostgreSQL via `@neondatabase/serverless`)
- **AI:** Anthropic SDK — `claude-haiku-4-5-20251001` for all AI calls
- **Payments:** Stripe — subscription at $9/month
- **Deploy:** Railway
- **Frontend:** Vanilla JS state machine (`A` object), single HTML file, no build step

---

## File structure

```
distill-app.html       — the full app (single HTML file, vanilla JS)
distill-landing.html   — marketing landing page
server.js              — Express 5 API + static serving
auth.js                — Better Auth config
db/
  index.js             — Drizzle + Neon client
  schema.js            — all tables
drizzle.config.js      — Drizzle Kit config
package.json
```

---

## Database schema (Neon)

Tables: `user`, `session`, `account`, `verification` (Better Auth), `capture`, `brief`, `subscription`

**capture** — photo/voice/text observations  
**brief** — held build candidates (from pressure test)  
**subscription** — Stripe subscription status per user

Push schema changes: `npm run db:push`

---

## Environment variables (set in Railway)

```
DATABASE_URL
BETTER_AUTH_SECRET
RESEND_API_KEY
BASE_URL=https://distill.ingenioussoul.com
ANTHROPIC_API_KEY
STRIPE_SECRET_KEY        — shared with Ingenious Stack (same Stripe account)
STRIPE_WEBHOOK_SECRET    — whsec_... from Stripe → Developers → Webhooks
```

**Important:** `STRIPE_SECRET_KEY` is shared with Ingenious Stack. Do not rotate it without updating both products.

---

## Stripe setup

- Price ID (hardcoded in server.js): `price_1TiiCy2kR40SoSdB8XGDLYBX` — $9/month recurring
- Webhook endpoint: `https://distill.ingenioussoul.com/api/stripe/webhook`
- Webhook events: `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`
- Webhook must be registered **before** `express.json()` middleware — raw body required for signature verification
- Billing portal enabled for subscribers (manage/cancel via Stripe)

---

## API routes

### Auth
- `ALL /api/auth/*path` — Better Auth handler

### Subscription
- `GET /api/subscription/status` — returns `{ active: bool }`
- `POST /api/stripe/checkout` — creates Stripe Checkout session, returns `{ url }`
- `POST /api/stripe/portal` — creates Stripe billing portal session, returns `{ url }`
- `POST /api/stripe/webhook` — Stripe webhook (raw body, before express.json)

### Captures (all require active subscription)
- `GET /api/captures`
- `POST /api/captures`
- `DELETE /api/captures/:id`

### Themes / AI (all require active subscription + rate limit)
- `POST /api/themes/analyze` — groups captures into 2–4 themes via Claude
- `POST /api/themes/kill` — deletes captures by ID array
- `POST /api/themes/pressure` — pressure test for a single theme

### Briefs (all require active subscription)
- `GET /api/briefs`
- `POST /api/briefs`
- `DELETE /api/briefs/:id`

### Build / Launch (requires active subscription + rate limit)
- `POST /api/build/launch` — generates one-liner, headline, launch note, Broadwave broadcast (140–155 chars)

### Hold to Speak / AI capture (requires active subscription + rate limit)
- `POST /api/capture/converse` — takes initial voice transcript, returns one sharpening question
- `POST /api/capture/distill` — takes initial + question + answer, returns distilled insight

---

## AI rate limiting

In-memory per-user limit: **30 AI calls/user/day**, resets every 24 hours.  
Applied to: `analyze`, `pressure`, `build/launch`, `capture/converse`, `capture/distill`  
Returns 429 with message "Daily AI limit reached — come back tomorrow."  
Resets on server restart (acceptable at this scale).

---

## App state machine

The app (`A` object in distill-app.html) is a vanilla JS state machine with `A.set(partial)` triggering re-renders via `innerHTML`.

**Screens:** `onboarding` → `feed` → `capture` → `captureInsight` → `themes` → `graduation` → `pressure` → `brief` → `launch`

**Key state fields:**
- `screen` — current screen
- `captureMode` — `'camera'` | `'voice'`
- `voiceConvPhase` — `null` | `'thinking'` | `'questioning'` | `'saving'` (v3 Hold to Speak phases)
- `voiceInitial`, `voiceQuestion` — conversation state for Hold to Speak
- `pressureData` — AI pressure test result
- `launchData` — AI launch copy result
- `heldBriefs` — saved build candidates

**Boot flow:**
1. Check session → if none, show sign-in
2. Check subscription status → if inactive, show paywall
3. Load captures + held briefs
4. Check `localStorage.getItem('distill_onboarded')` → show onboarding if first time

---

## Versions shipped this session

**v1** — SEE → THINK loop: capture, AI pattern detection, graduation, pressure test, brief, Claude Code prompt  
**v2** — BUILD phase: AI launch copy (one-liner, headline, launch note, Broadwave broadcast at 160-char constraint), "Write the launch →" CTA on brief screen  
**v3** — Hold to Speak AI layer: voice → AI asks one sharpening question → answer → auto-distilled insight saved as capture  

---

## Important decisions

- **Stripe key shared with Stack** — do not rotate without updating both products
- **Webhook before express.json()** — raw body required; was the source of a signature failure bug
- **Broadwave handoff is copy-to-clipboard for now** — direct API handoff deferred until 10DLC verification clears
- **AI model is Haiku** — cheap enough ($0.003/full flow) that $9/mo is sustainable at any realistic scale; no need to raise price
- **No audio storage** — Hold to Speak transcribes to text only; no audio files, no object storage needed
- **`allow_promotion_codes: true`** in Stripe checkout — coupon codes work automatically, no code changes needed
- **Landing page demo auto-cycles** — camera(3.2s) → captured(3s) → patterns(4s) → brief(4.2s), pauses on hover/touch
- **`distill_onboarded` in localStorage** — first-time users see onboarding screen; `localStorage.removeItem('distill_onboarded')` to reset for testing
- **Check in before deploying** — user preference: discuss changes before deploying, don't ship silently
