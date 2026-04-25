// ═══════════════════════════════════════════════════════════════
//  Stackborn AI — Vercel Production Backend
//  Sessions stored in Firebase (not memory) for serverless
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const twilio  = require('twilio');
const cors    = require('cors');

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const { VoiceResponse } = twilio.twiml;

const TWILIO_SID   = process.env.TWILIO_SID;
const TWILIO_TOKEN = process.env.TWILIO_TOKEN;
const TWILIO_NUM   = process.env.TWILIO_NUM   || '+17403064960';
const GROQ_KEY     = process.env.GROQ_KEY;
const FB_PROJECT   = 'stackborn-ai';
const FB_KEY       = process.env.FB_KEY;

const twilioClient = twilio(TWILIO_SID, TWILIO_TOKEN);

// ── Firebase REST ─────────────────────────────────────────────
const FB = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents`;

const toFS = obj => {
  const f = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string')  f[k] = { stringValue: v };
    if (typeof v === 'boolean') f[k] = { booleanValue: v };
    if (typeof v === 'number')  f[k] = { integerValue: String(v) };
  }
  return { fields: f };
};

const fromFS = doc => {
  if (!doc?.name) return null;
  const o = { id: doc.name.split('/').pop() };
  for (const [k, v] of Object.entries(doc.fields || {}))
    o[k] = v.stringValue ?? v.booleanValue ?? v.integerValue ?? '';
  return o;
};

const fsSet = (col, id, data) =>
  fetch(`${FB}/${col}/${id}?key=${FB_KEY}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(toFS(data))
  }).catch(e => console.error('[fsSet]', e.message));

const fsGet = async (col, id) => {
  try {
    const r = await fetch(`${FB}/${col}/${id}?key=${FB_KEY}`);
    if (!r.ok) return null;
    return fromFS(await r.json());
  } catch { return null; }
};

const fsList = async col => {
  try {
    const r = await fetch(`${FB}/${col}?key=${FB_KEY}&pageSize=200`);
    const d = await r.json();
    return (d.documents || []).map(fromFS).filter(Boolean);
  } catch { return []; }
};

// ── Session helpers (Firebase-backed for serverless) ──────────
const getSession = async (callSid) => {
  const s = await fsGet('sessions', callSid);
  if (!s) return null;
  // history is stored as JSON string
  try { s.history = JSON.parse(s.historyJson || '[]'); } catch { s.history = []; }
  s.turns = parseInt(s.turns) || 0;
  return s;
};

const saveSession = async (callSid, data) => {
  const toSave = { ...data };
  if (toSave.history) {
    toSave.historyJson = JSON.stringify(toSave.history);
    delete toSave.history;
  }
  await fsSet('sessions', callSid, toSave);
};

// ── Groq ──────────────────────────────────────────────────────
async function askGroq(history, userName) {
  const system = `You are Stackborn AI, a professional voice assistant answering calls on behalf of ${userName}.
The user is currently unavailable. Your job:
1. Greet the caller warmly and explain the user is unavailable.
2. Ask for their name and reason for calling.
3. After 1-2 exchanges decide:
   - [PASS] if: family, friend, doctor, delivery, business, appointment, emergency, personal.
   - [BLOCK] if: sales, marketing, telemarketing, spam, survey, OTP fraud, unknown solicitor.
4. Append [PASS] or [BLOCK] at the end of your final reply.
5. Keep ALL replies under 20 words — this is spoken on phone.
6. Be warm, natural, Indian-English friendly.
Examples:
  First: "Hi! ${userName} is unavailable. I'm their AI assistant. Your name and reason please?"
  Pass:  "Got it! Let me connect you to ${userName} now. [PASS]"
  Block: "Thank you. ${userName} isn't available for sales calls. Goodbye! [BLOCK]"`;

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3-8b-8192', max_tokens: 100, temperature: 0.4,
        messages: [{ role: 'system', content: system }, ...history]
      })
    });
    const d = await r.json();
    return d.choices?.[0]?.message?.content?.trim() || '';
  } catch (e) {
    console.error('[Groq]', e.message);
    return `Let me connect you to ${userName} now. [PASS]`;
  }
}

const clean   = t => t.replace(/\[PASS\]|\[BLOCK\]/g, '').trim();
const isPass  = t => t.includes('[PASS]');
const isBlock = t => t.includes('[BLOCK]');
const now     = () => new Date().toISOString();
const HOST    = () => process.env.HOST || 'https://stackborn-backend.vercel.app';

// ═══════════════════════════════════════════════════════════════
//  VOICE ROUTES
// ═══════════════════════════════════════════════════════════════

app.post('/incoming', async (req, res) => {
  const { CallSid, From, To } = req.body;
  console.log(`[INCOMING] ${CallSid} from ${From}`);

  const cfg      = await fsGet('config', 'settings');
  const userName = cfg?.userName  || 'the person you called';
  const forwardTo = cfg?.forwardTo || '';

  // Save initial call record
  await fsSet('calls', CallSid, {
    callSid: CallSid, from: From, startTime: now(),
    status: 'screening', verdict: 'pending',
    summary: '', transcript: '', callerName: ''
  });

  // Get AI greeting
  let greeting = '';
  try {
    greeting = await askGroq([{ role: 'user', content: 'Call just connected. Greet the caller.' }], userName);
  } catch {
    greeting = `Hi! ${userName} is unavailable. I'm their AI assistant. Your name and reason please?`;
  }

  // Save session to Firebase
  await saveSession(CallSid, {
    callSid: CallSid, from: From, to: To || '',
    userName, forwardTo, turns: 0,
    start: now(), callerName: '', callerReason: '',
    history: [{ role: 'assistant', content: greeting }]
  });

  const twiml = new VoiceResponse();
  const g = twiml.gather({
    input: 'speech', action: `${HOST()}/gather`,
    method: 'POST', speechTimeout: 'auto',
    language: 'en-IN', timeout: 12
  });
  g.say({ voice: 'alice', language: 'en-IN' }, clean(greeting));
  twiml.redirect(`${HOST()}/no-input`);

  res.type('text/xml').send(twiml.toString());
});

app.post('/gather', async (req, res) => {
  const { CallSid, SpeechResult, From } = req.body;
  const twiml = new VoiceResponse();

  // Load session
  let s = await getSession(CallSid);
  if (!s) {
    const cfg = await fsGet('config', 'settings');
    s = {
      callSid: CallSid, from: From,
      userName: cfg?.userName || 'the person',
      forwardTo: cfg?.forwardTo || '',
      history: [], turns: 0, start: now(),
      callerName: '', callerReason: ''
    };
  }

  if (!SpeechResult?.trim()) {
    if (s.turns >= 2) {
      twiml.say({ voice: 'alice', language: 'en-IN' },
        `I'll let ${s.userName} know you called. Goodbye!`);
      twiml.hangup();
      await fsSet('calls', CallSid, {
        callSid: CallSid, from: s.from, startTime: s.start,
        status: 'completed', verdict: 'NO_RESPONSE',
        summary: 'Caller did not respond.', transcript: ''
      });
      return res.type('text/xml').send(twiml.toString());
    }
    s.turns++;
    await saveSession(CallSid, s);
    const g = twiml.gather({
      input: 'speech', action: `${HOST()}/gather`,
      method: 'POST', speechTimeout: 'auto', language: 'en-IN', timeout: 10
    });
    g.say({ voice: 'alice', language: 'en-IN' }, "Sorry, I didn't catch that. Could you say your name and reason?");
    return res.type('text/xml').send(twiml.toString());
  }

  s.turns++;
  s.history.push({ role: 'user', content: SpeechResult });
  if (!s.callerReason) s.callerReason = SpeechResult;

  const aiText = await askGroq(s.history, s.userName);
  s.history.push({ role: 'assistant', content: aiText });
  await saveSession(CallSid, s);

  const spoken     = clean(aiText);
  const transcript = s.history.map(h => `${h.role === 'assistant' ? 'AI' : 'Caller'}: ${h.content}`).join('\n');
  const summary    = s.callerReason || SpeechResult;
  const forceBlock = s.turns >= 4 && !isPass(aiText) && !isBlock(aiText);

  if (isPass(aiText)) {
    twiml.say({ voice: 'alice', language: 'en-IN' },
      spoken || `Great! Connecting you to ${s.userName} now. Please hold.`);

    if (s.forwardTo) {
      const dial = twiml.dial({
        callerId: TWILIO_NUM, timeout: 25,
        action: `${HOST()}/dial-status?callSid=${CallSid}&summary=${encodeURIComponent(summary)}&transcript=${encodeURIComponent(transcript)}`,
        method: 'POST'
      });
      dial.number(s.forwardTo);
    } else {
      twiml.say({ voice: 'alice', language: 'en-IN' },
        `${s.userName} isn't reachable right now. They'll call you back. Goodbye!`);
      twiml.hangup();
    }
    await fsSet('calls', CallSid, {
      callSid: CallSid, from: s.from, startTime: s.start,
      status: 'connecting', verdict: 'PASS', summary, transcript, callerName: s.callerName || ''
    });

  } else if (isBlock(aiText) || forceBlock) {
    twiml.say({ voice: 'alice', language: 'en-IN' },
      spoken || `Thank you for calling. ${s.userName} is unavailable for this. Goodbye!`);
    twiml.hangup();
    await fsSet('calls', CallSid, {
      callSid: CallSid, from: s.from, startTime: s.start,
      status: 'completed', verdict: 'BLOCK', summary, transcript, callerName: s.callerName || ''
    });

  } else {
    const g = twiml.gather({
      input: 'speech', action: `${HOST()}/gather`,
      method: 'POST', speechTimeout: 'auto', language: 'en-IN', timeout: 10
    });
    g.say({ voice: 'alice', language: 'en-IN' }, spoken || 'Could you tell me a bit more?');
    twiml.redirect(`${HOST()}/no-input`);
  }

  res.type('text/xml').send(twiml.toString());
});

app.post('/dial-status', async (req, res) => {
  const { DialCallStatus } = req.body;
  const { callSid, summary, transcript } = req.query;
  const twiml = new VoiceResponse();
  const s = await getSession(callSid) || {};
  const sum = decodeURIComponent(summary || '');
  const tr  = decodeURIComponent(transcript || '');

  if (DialCallStatus === 'completed') {
    await fsSet('calls', callSid, {
      callSid, from: s.from || '', startTime: s.start || now(),
      status: 'completed', verdict: 'PASS',
      summary: `Connected. ${sum}`, transcript: tr, callerName: s.callerName || ''
    });
    twiml.hangup();
  } else {
    twiml.say({ voice: 'alice', language: 'en-IN' },
      `${s.userName || 'They'} couldn't answer. Please leave a message after the beep.`);
    twiml.record({
      action: `${HOST()}/recording?callSid=${callSid}`,
      method: 'POST', maxLength: 60, timeout: 5,
      transcribe: true,
      transcribeCallback: `${HOST()}/transcription?callSid=${callSid}`
    });
    await fsSet('calls', callSid, {
      callSid, from: s.from || '', startTime: s.start || now(),
      status: 'voicemail', verdict: 'PASS',
      summary: `Voicemail. ${sum}`, transcript: tr, callerName: s.callerName || ''
    });
  }
  res.type('text/xml').send(twiml.toString());
});

app.post('/recording', async (req, res) => {
  const { RecordingUrl } = req.body;
  const { callSid } = req.query;
  if (callSid && RecordingUrl) await fsSet('calls', callSid, { recordingUrl: RecordingUrl, status: 'voicemail_recorded' });
  const twiml = new VoiceResponse();
  twiml.say({ voice: 'alice', language: 'en-IN' }, 'Thank you for your message. Goodbye!');
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

app.post('/transcription', async (req, res) => {
  const { TranscriptionText } = req.body;
  const { callSid } = req.query;
  if (callSid && TranscriptionText) await fsSet('calls', callSid, { voicemailText: TranscriptionText });
  res.sendStatus(200);
});

app.post('/no-input', async (req, res) => {
  const { CallSid } = req.body;
  const s = await getSession(CallSid) || {};
  const twiml = new VoiceResponse();
  twiml.say({ voice: 'alice', language: 'en-IN' }, `I'll let ${s.userName || 'them'} know you called. Goodbye!`);
  twiml.hangup();
  await fsSet('calls', CallSid, {
    callSid: CallSid, from: s.from || '', startTime: s.start || now(),
    status: 'completed', verdict: 'NO_RESPONSE', summary: 'Caller went silent.', transcript: ''
  });
  res.type('text/xml').send(twiml.toString());
});

// ── API ───────────────────────────────────────────────────────
app.get('/calls', async (req, res) => {
  const calls = await fsList('calls');
  calls.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
  res.json(calls);
});

app.get('/profile', async (req, res) => {
  const cfg = await fsGet('config', 'settings');
  res.json(cfg || { forwardTo: '', userName: '' });
});

app.post('/profile', async (req, res) => {
  const { forwardTo, userName } = req.body;
  if (!forwardTo) return res.status(400).json({ error: 'forwardTo required' });
  await fsSet('config', 'settings', { forwardTo, userName: userName || 'the user' });
  res.json({ ok: true, forwardTo, userName });
});

app.post('/test-call', async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'to required' });
  try {
    const call = await twilioClient.calls.create({ to, from: TWILIO_NUM, url: `${HOST()}/incoming`, method: 'POST' });
    res.json({ ok: true, callSid: call.sid });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/', (_, res) => res.json({ ok: true, app: 'Stackborn AI', version: '2.0.0', host: HOST() }));

module.exports = app;
