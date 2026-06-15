require('dotenv/config');
const express = require('express');
const path = require('path');
const { toNodeHandler } = require('better-auth/node');
const { auth } = require('./auth');
const { db } = require('./db/index');
const { capture, brief } = require('./db/schema');
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

// Captures API
app.get('/api/captures', async (req, res) => {
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

app.post('/api/captures', async (req, res) => {
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

app.delete('/api/captures/:id', async (req, res) => {
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
app.post('/api/themes/analyze', async (req, res) => {
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
app.post('/api/themes/kill', async (req, res) => {
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
app.get('/api/briefs', async (req, res) => {
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

app.post('/api/briefs', async (req, res) => {
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

app.delete('/api/briefs/:id', async (req, res) => {
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
app.post('/api/themes/pressure', async (req, res) => {
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
