require('dotenv/config');
const express = require('express');
const path = require('path');
const { toNodeHandler } = require('better-auth/node');
const { auth } = require('./auth');
const { db } = require('./db/index');
const { capture } = require('./db/schema');
const { eq, desc } = require('drizzle-orm');
const { randomUUID } = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Better Auth handler — must come before static/other routes
app.all('/api/auth/*', toNodeHandler(auth));

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
