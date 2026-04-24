// ═══════════════════════════════════════════════════════════
//  Stackborn AI — Backend Server
//  Deploy this on Railway. Set /incoming as Twilio webhook.
// ═══════════════════════════════════════════════════════════
const express = require('express');
const twilio = require('twilio');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const { VoiceResponse } = twilio.twiml;

// ── All credentials (pre-filled) ─────────────────────────
const C = {
  twilioSid: process.env.TWILIO_SID,
  twilioToken: process.env.TWILIO_TOKEN,
  twilioNum: process.env.TWILIO_NUM,
  groqKey: process.env.GROQ_KEY,
  fbProject: 'stackborn-ai',
  fbKey: process.env.FB_KEY,
};
// ── Firebase Firestore REST helpers ───────────────────────
const FB = `https://firestore.googleapis.com/v1/projects/${C.fbProject}/databases/(default)/documents`;

const toFS = obj => {
  const f = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') f[k] = { stringValue: v };
    if (typeof v === 'boolean') f[k] = { booleanValue: v };
    if (typeof v === 'number') f[k] = { integerValue: String(v) };
  }
  return { fields: f };
};

const fromFS = doc => {
  const o = { id: doc.name.split('/').pop() };
  for (const [k, v] of Object.entries(doc.fields || {}))
    o[k] = v.stringValue ?? v.booleanValue ?? v.integerValue ?? '';
  return o;
};

const fsSet = (col, id, data) =>
  fetch(`${FB}/${col}/${id}?key=${C.fbKey}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(toFS(data))
  }).catch(e => console.error('fsSet error', e.message));

const fsGet = async (col, id) => {
  const r = await fetch(`${FB}/${col}/${id}?key=${C.fbKey}`);
  if (!r.ok) return null;
  return fromFS(await r.json());
};

const fsList = async col => {
  const r = await fetch(`${FB}/${col}?key=${C.fbKey}&pageSize=200`);
  const d = await r.json();
  return (d.documents || []).map(fromFS);
};

// ── Active call sessions (in-memory) ─────────────────────
const sessions = {};

// ── Groq AI system prompt ─────────────────────────────────
const SYSTEM = `You are Stackborn AI — a professional phone call screening assistant answering on behalf of the user.
Rules:
- Be VERY brief. This is spoken over phone. Max 15 words per reply.
- Ask the caller's name and reason for calling.
- After 1–2 exchanges, append [PASS] or [BLOCK] to your reply.
- PASS: family, friends, genuine business, delivery, appointment, emergency.
- BLOCK: sales, spam, surveys, marketing, scam, unknown solicitors, OTP fraud.
Examples:
  First turn: "Hi, I'm Stackborn AI screening calls. Name and reason please?"
  PASS: "Thanks Priya! Connecting you now. [PASS]"
  BLOCK: "Thank you. They're unavailable for sales calls. Goodbye. [BLOCK]"`;

// ── Groq call ─────────────────────────────────────────────
async function askGroq(history) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${C.groqKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama3-8b-8192',
      max_tokens: 80,
      messages: [{ role: 'system', content: SYSTEM }, ...history]
    })
  });
  const d = await r.json();
  return d.choices?.[0]?.message?.content || '';
}

// ═══════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════

// Health check
app.get('/', (_, res) => res.json({ ok: true, app: 'Stackborn AI', version: '1.0.0' }));

// ── /incoming  ←  Twilio calls this for EVERY call ────────
app.post('/incoming', async (req, res) => {
  const { CallSid, From } = req.body;
  const twiml = new VoiceResponse();

  // Init session
  sessions[CallSid] = { from: From, history: [], turns: 0, start: new Date().toISOString() };

  // Save to Firestore
  fsSet('calls', CallSid, {
    callSid: CallSid, from: From,
    startTime: sessions[CallSid].start,
    status: 'screening', verdict: 'pending', summary: ''
  });

  // Ask caller to speak
  const g = twiml.gather({
    input: 'speech', action: '/gather', method: 'POST',
    speechTimeout: 'auto', language: 'en-IN', timeout: 10
  });
  g.say({ voice: 'alice', language: 'en-IN' },
    'Hello, I am Stackborn AI screening this call. Please say your name and reason for calling.');

  // If no speech, loop
  twiml.redirect('/incoming');
  res.type('text/xml').send(twiml.toString());
});

// ── /gather  ←  processes what caller said ────────────────
app.post('/gather', async (req, res) => {
  const { CallSid, SpeechResult, From } = req.body;
  const twiml = new VoiceResponse();
  const s = sessions[CallSid] || { from: From, history: [], turns: 0, start: new Date().toISOString() };

  // No speech detected
  if (!SpeechResult) {
    const g = twiml.gather({
      input: 'speech', action: '/gather', method: 'POST',
      speechTimeout: 'auto', language: 'en-IN', timeout: 8
    });
    g.say({ voice: 'alice', language: 'en-IN' }, 'Sorry, I did not catch that. Please say your name and reason.');
    return res.type('text/xml').send(twiml.toString());
  }

  s.turns++;
  s.history.push({ role: 'user', content: SpeechResult });

  // Get AI decision
  let aiText = '';
  try {
    aiText = await askGroq(s.history);
  } catch (e) {
    console.error('Groq error:', e.message);
    aiText = 'Connecting you now. [PASS]';
  }

  s.history.push({ role: 'assistant', content: aiText });
  sessions[CallSid] = s;

  const isPass = aiText.includes('[PASS]');
  const isBlock = aiText.includes('[BLOCK]') || s.turns >= 3;
  const spoken = aiText.replace(/\[PASS\]|\[BLOCK\]/g, '').trim();
  const summary = spoken || SpeechResult;
  const transcript = s.history.map(h => `${h.role}: ${h.content}`).join(' | ');

  if (isPass) {
    // Announce + forward to user's real number
    twiml.say({ voice: 'alice', language: 'en-IN' }, spoken || 'Connecting you now, please hold.');

    const cfg = await fsGet('config', 'settings').catch(() => null);
    const fwdTo = cfg?.forwardTo || '';

    if (fwdTo) {
      const dial = twiml.dial({ callerId: s.from, timeout: 30 });
      dial.number(fwdTo);
    } else {
      twiml.say({ voice: 'alice', language: 'en-IN' },
        'The forwarding number is not configured yet. Please try again later. Goodbye.');
      twiml.hangup();
    }

    fsSet('calls', CallSid, {
      callSid: CallSid, from: s.from, startTime: s.start,
      status: 'completed', verdict: 'PASS', summary, transcript
    });

  } else if (isBlock) {
    // Politely reject
    twiml.say({ voice: 'alice', language: 'en-IN' },
      spoken || 'Thank you for calling. The person is not available right now. Goodbye.');
    twiml.hangup();

    fsSet('calls', CallSid, {
      callSid: CallSid, from: s.from, startTime: s.start,
      status: 'completed', verdict: 'BLOCK', summary, transcript
    });

  } else {
    // Continue conversation
    const g = twiml.gather({
      input: 'speech', action: '/gather', method: 'POST',
      speechTimeout: 'auto', language: 'en-IN', timeout: 8
    });
    g.say({ voice: 'alice', language: 'en-IN' }, spoken || 'Could you tell me a bit more?');
  }

  res.type('text/xml').send(twiml.toString());
});

// ── /calls  ←  Dashboard fetches real call history ────────
app.get('/calls', async (req, res) => {
  try {
    const calls = await fsList('calls');
    calls.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
    res.json(calls);
  } catch (e) {
    res.json([]);
  }
});

// ── /profile  ←  Save user's real forwarding number ───────
app.post('/profile', async (req, res) => {
  const { forwardTo } = req.body;
  if (!forwardTo) return res.status(400).json({ error: 'forwardTo required' });
  await fsSet('config', 'settings', { forwardTo });
  res.json({ ok: true, forwardTo });
});

app.get('/profile', async (req, res) => {
  const cfg = await fsGet('config', 'settings').catch(() => null);
  res.json(cfg || { forwardTo: '' });
});

// ── Start ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🤖 Stackborn AI running on :${PORT}`));