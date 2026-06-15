require('dotenv/config');
const express = require('express');
const path = require('path');
const { toNodeHandler } = require('better-auth/node');
const { auth } = require('./auth');
const { db } = require('./db/index');
const { capture, brief, subscription } = require('./db/schema');
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || '');
const PRICE_ID = 'price_1TiiCy2kR40SoSdB8XGDLYBX';
const { eq, desc, inArray } = require('drizzle-orm');
const { randomUUID } = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

// Simple in-memory AI rate limiter — 30 calls per user per day
const _aiCalls = new Map();
function checkAILimit(userId) {
  const now = Date.now();
  const dayMs = 86_400_000;
  const entry = _aiCalls.get(userId) || { count: 0, reset: now + dayMs };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + dayMs; }
  if (entry.count >= 30) return false;
  entry.count++;
  _aiCalls.set(userId, entry);
  return true;
}

app.use(express.json());

// Better Auth handler — must come before static/other routes
app.all('/api/auth/*path', toNodeHandler(auth));

// ── Subscription helpers ──────────────────────────────────────────────────────
async function getSubscription(userId) {
  const rows = await db.select().from(subscription).where(eq(subscription.userId, userId));
  return rows[0] || null;
}

async function isActive(userId) {
  const sub = await getSubscription(userId);
  if (!sub) return false;
  const active = sub.status === 'active' || sub.status === 'trialing';
  if (!active) return false;
  if (sub.currentPeriodEnd && new Date() > sub.currentPeriodEnd) return false;
  return true;
}

// ── Subscription status ───────────────────────────────────────────────────────
app.get('/api/subscription/status', async (req, res) => {
  try {
    const session = await auth.api.getSession({ headers: req.headers });
    if (!session) return res.status(401).json({ error: 'Unauthorized' });
    const active = await isActive(session.user.id);
    res.json({ active });
  } catch (err) {
    console.error('GET /api/subscription/status', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Stripe checkout ───────────────────────────────────────────────────────────
app.post('/api/stripe/checkout', async (req, res) => {
  try {
    const session = await auth.api.getSession({ headers: req.headers });
    if (!session) return res.status(401).json({ error: 'Unauthorized' });

    let sub = await getSubscription(session.user.id);
    let customerId = sub?.stripeCustomerId;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: session.user.email,
        metadata: { userId: session.user.id },
      });
      customerId = customer.id;
    }

    const checkout = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{ price: PRICE_ID, quantity: 1 }],
      mode: 'subscription',
      success_url: `${process.env.BASE_URL}/app?subscribed=1`,
      cancel_url: `${process.env.BASE_URL}/app`,
      allow_promotion_codes: true,
    });

    res.json({ url: checkout.url });
  } catch (err) {
    console.error('POST /api/stripe/checkout', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Stripe portal (manage/cancel) ────────────────────────────────────────────
app.post('/api/stripe/portal', async (req, res) => {
  try {
    const session = await auth.api.getSession({ headers: req.headers });
    if (!session) return res.status(401).json({ error: 'Unauthorized' });

    const sub = await getSubscription(session.user.id);
    if (!sub?.stripeCustomerId) return res.status(400).json({ error: 'No subscription found' });

    const portal = await stripe.billingPortal.sessions.create({
      customer: sub.stripeCustomerId,
      return_url: `${process.env.BASE_URL}/app`,
    });

    res.json({ url: portal.url });
  } catch (err) {
    console.error('POST /api/stripe/portal', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── Stripe webhook ────────────────────────────────────────────────────────────
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET || '');
  } catch (err) {
    console.error('Webhook signature failed', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const upsertSub = async (stripeObj) => {
    const customerId = stripeObj.customer;
    const customer = await stripe.customers.retrieve(customerId);
    const userId = customer.metadata?.userId;
    if (!userId) return;

    const periodEnd = stripeObj.current_period_end
      ? new Date(stripeObj.current_period_end * 1000)
      : null;

    const existing = await getSubscription(userId);
    if (existing) {
      await db.update(subscription)
        .set({
          stripeCustomerId: customerId,
          stripeSubscriptionId: stripeObj.id,
          status: stripeObj.status,
          currentPeriodEnd: periodEnd,
        })
        .where(eq(subscription.userId, userId));
    } else {
      await db.insert(subscription).values({
        id: randomUUID(),
        userId,
        stripeCustomerId: customerId,
        stripeSubscriptionId: stripeObj.id,
        status: stripeObj.status,
        currentPeriodEnd: periodEnd,
      });
    }
  };

  try {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await upsertSub(event.data.object);
        break;
    }
  } catch (err) {
    console.error('Webhook handler error', err);
    return res.status(500).end();
  }

  res.json({ received: true });
});

// ── Subscription gate middleware ──────────────────────────────────────────────
async function requireSub(req, res, next) {
  try {
    const session = await auth.api.getSession({ headers: req.headers });
    if (!session) return res.status(401).json({ error: 'Unauthorized' });
    const active = await isActive(session.user.id);
    if (!active) return res.status(402).json({ error: 'Subscription required' });
    next();
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
}

// Captures API
app.get('/api/captures', requireSub, async (req, res) => {
  try {
    const session = await auth.api.getSession({ headers: req.headers });
    if (!session) return res.status(401).json({ error: 'Unauthorized' });

    const rows = await db
      .select()
      .from(capture)
      .where(eq(capture.userId, session.user.id))
      .orderBy(desc(capture.createdAt));

    const parsed = rows.map(r => ({
      ...r,
      tags: r.tags ? JSON.parse(r.tags) : [],
    }));
    res.json(parsed);
  } catch (err) {
    console.error('GET /api/captures', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/captures', requireSub, async (req, res) => {
  try {
    const session = await auth.api.getSession({ headers: req.headers });
    if (!session) return res.status(401).json({ error: 'Unauthorized' });

    const { type, title, raw, summary, tags, imageUrl, audioUrl } = req.body;

    const [row] = await db
      .insert(capture)
      .values({
        id: randomUUID(),
        userId: session.user.id,
        type: type || 'text',
        title: title || null,
        raw: raw || null,
        summary: summary || null,
        tags: tags ? JSON.stringify(tags) : null,
        imageUrl: imageUrl || null,
        audioUrl: audioUrl || null,
      })
      .returning();

    res.status(201).json({ ...row, tags: row.tags ? JSON.parse(row.tags) : [] });
  } catch (err) {
    console.error('POST /api/captures', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/captures/:id', requireSub, async (req, res) => {
  try {
    const session = await auth.api.getSession({ headers: req.headers });
    if (!session) return res.status(401).json({ error: 'Unauthorized' });

    await db
      .delete(capture)
      .where(eq(capture.id, req.params.id));

    res.status(204).end();
  } catch (err) {
    console.error('DELETE /api/captures', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Themes — AI pattern detection
app.post('/api/themes/analyze', requireSub, async (req, res) => {
  try {
    const session = await auth.api.getSession({ headers: req.headers });
    if (!session) return res.status(401).json({ error: 'Unauthorized' });

    if (!checkAILimit(session.user.id)) {
      return res.status(429).json({ error: 'Daily AI limit reached — come back tomorrow.' });
    }

    const rows = await db
      .select()
      .from(capture)
      .where(eq(capture.userId, session.user.id))
      .orderBy(desc(capture.createdAt));

    if (rows.length < 3) {
      return res.json({ themes: [], message: 'Add at least 3 captures to find patterns.' });
    }

    const client = new Anthropic();
    const captureList = rows.map((c, i) => `${i + 1}. ${c.title || c.raw || ''}`).join('\n');

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `You are analyzing friction observations someone has collected to find recurring patterns. Group these captures into 2-4 themes. Each theme should represent a real pattern — something that keeps showing up in different forms.

Captures:
${captureList}

Return ONLY a JSON array, no explanation. Format:
[
  {
    "name": "Short pattern name (3-5 words)",
    "blurb": "One sentence describing what this pattern is about",
    "captures": [1, 3, 5]
  }
]

The captures array should contain the 1-based index numbers of captures that belong to this theme. A capture can only belong to one theme. If a capture doesn't fit any pattern, leave it out.`,
      }],
    });

    const text = message.content[0].text.trim();
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return res.json({ themes: [], message: 'Could not detect patterns yet.' });

    const rawThemes = JSON.parse(jsonMatch[0]);
    const themes = rawThemes.map((t, i) => ({
      id: 'ai-' + i,
      name: t.name,
      blurb: t.blurb,
      count: t.captures.length,
      threshold: 3,
      graduated: t.captures.length >= 3,
      captureIndices: t.captures,
      captures: t.captures.map(idx => rows[idx - 1]).filter(Boolean).map(c => ({
        id: c.id,
        insight: c.title || c.raw || '',
        time: new Date(c.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        tone: '#3A3830',
      })),
    }));

    res.json({ themes });
  } catch (err) {
    console.error('POST /api/themes/analyze', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Kill theme — delete all its captures
app.post('/api/themes/kill', requireSub, async (req, res) => {
  try {
    const session = await auth.api.getSession({ headers: req.headers });
    if (!session) return res.status(401).json({ error: 'Unauthorized' });

    const { captureIds } = req.body;
    if (!captureIds || !captureIds.length) return res.status(400).json({ error: 'No captures' });

    await db.delete(capture).where(inArray(capture.id, captureIds));
    res.status(204).end();
  } catch (err) {
    console.error('POST /api/themes/kill', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Briefs — hold an idea for later
app.get('/api/briefs', requireSub, async (req, res) => {
  try {
    const session = await auth.api.getSession({ headers: req.headers });
    if (!session) return res.status(401).json({ error: 'Unauthorized' });

    const rows = await db.select().from(brief)
      .where(eq(brief.userId, session.user.id))
      .orderBy(desc(brief.createdAt));

    res.json(rows.map(r => ({ ...r, stack: r.stack ? JSON.parse(r.stack) : [] })));
  } catch (err) {
    console.error('GET /api/briefs', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/briefs', requireSub, async (req, res) => {
  try {
    const session = await auth.api.getSession({ headers: req.headers });
    if (!session) return res.status(401).json({ error: 'Unauthorized' });

    const { themeName, themeBlurb, forWho, smallestVersion, frictionVerdict, stack } = req.body;

    const [row] = await db.insert(brief).values({
      id: randomUUID(),
      userId: session.user.id,
      themeName,
      themeBlurb: themeBlurb || null,
      forWho: forWho || null,
      smallestVersion: smallestVersion || null,
      frictionVerdict: frictionVerdict || null,
      stack: stack ? JSON.stringify(stack) : null,
      status: 'held',
    }).returning();

    res.status(201).json({ ...row, stack: row.stack ? JSON.parse(row.stack) : [] });
  } catch (err) {
    console.error('POST /api/briefs', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/briefs/:id', requireSub, async (req, res) => {
  try {
    const session = await auth.api.getSession({ headers: req.headers });
    if (!session) return res.status(401).json({ error: 'Unauthorized' });

    await db.delete(brief).where(eq(brief.id, req.params.id));
    res.status(204).end();
  } catch (err) {
    console.error('DELETE /api/briefs', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Pressure test — AI analysis for a single theme
app.post('/api/themes/pressure', requireSub, async (req, res) => {
  try {
    const session = await auth.api.getSession({ headers: req.headers });
    if (!session) return res.status(401).json({ error: 'Unauthorized' });

    const { themeName, themeBlurb, captures } = req.body;
    if (!themeName || !captures || !captures.length) {
      return res.status(400).json({ error: 'Missing theme data' });
    }

    if (!checkAILimit(session.user.id)) {
      return res.status(429).json({ error: 'Daily AI limit reached — come back tomorrow.' });
    }

    const client = new Anthropic();
    const captureList = captures.map((c, i) => `${i + 1}. ${c.insight}`).join('\n');

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: `A builder has noticed a recurring friction pattern: "${themeName}" — ${themeBlurb}

Their captures:
${captureList}

Write a sharp pressure test for this as a potential product. Also suggest the right tech stack — pick from the builder's default stack where it fits, and add specific tools where the default doesn't cover it.

Builder's default stack: Express 5, Better Auth, Drizzle + Neon, Railway, Vite, React

Return ONLY valid JSON:
{
  "forWho": "One sentence — who feels this friction acutely (be specific, not generic)",
  "smallestVersion": "One sentence — the single smallest thing that removes this friction and nothing else",
  "frictionVerdict": "One sentence — why this friction is real and worth solving (cite the pattern)",
  "stack": ["array of 3-5 tech names — use default stack items where they fit, add new ones where the default lacks something specific for this idea"]
}`,
      }],
    });

    const text = message.content[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(500).json({ error: 'Could not generate pressure test' });

    res.json(JSON.parse(jsonMatch[0]));
  } catch (err) {
    console.error('POST /api/themes/pressure', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Static + pages
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'distill-landing.html'));
});

app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'distill-app.html'));
});

app.listen(PORT, () => {
  console.log(`Distill running on port ${PORT}`);
});
