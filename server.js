// ═══════════════════════════════════════════════════════════════
//  Stackborn AI — Production Backend
//  Full Workflow:
//  Caller → User unavailable → AI picks up → Screens → 
//  PASS: tries to connect user → if no answer, takes message
//  BLOCK: politely ends call
//  All calls + transcripts saved to Firebase
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const twilio  = require('twilio');
const cors    = require('cors');

const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const { VoiceResponse } = twilio.twiml;

// ── Env vars (set in Railway) ─────────────────────────────────
const TWILIO_SID   = process.env.TWILIO_SID;
const TWILIO_TOKEN = process.env.TWILIO_TOKEN;
const TWILIO_NUM   = process.env.TWILIO_NUM   || '+17403064960';
const GROQ_KEY     = process.env.GROQ_KEY;
const FB_PROJECT   = 'stackborn-ai';
const FB_KEY       = process.env.FB_KEY;

const twilioClient = twilio(TWILIO_SID, TWILIO_TOKEN);

// ── Firebase Firestore REST ───────────────────────────────────
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
  if (!doc || !doc.name) return null;
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
  }).catch(e => console.error('[fsSet error]', e.message));

const fsGet = async (col, id) => {
  const r = await fetch(`${FB}/${col}/${id}?key=${FB_KEY}`);
  if (!r.ok) return null;
  return fromFS(await r.json());
};

const fsList = async col => {
  const r = await fetch(`${FB}/${col}?key=${FB_KEY}&pageSize=200`);
  const d = await r.json();
  return (d.documents || []).map(fromFS).filter(Boolean);
};

// ── In-memory sessions ────────────────────────────────────────
// { [CallSid]: { from, callerName, history, turns, start, forwardTo } }
const sessions = {};

// ── Groq AI ───────────────────────────────────────────────────
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
6. Be warm, natural, Indian-English accent friendly.
Example replies:
  First: "Hi! ${userName} is unavailable right now. I'm their AI assistant. Your name and reason please?"
  Pass:  "Got it Priya! Let me try connecting you to ${userName} now. [PASS]"
  Block: "Thank you. ${userName} isn't available for sales calls. I'll let them know. Goodbye! [BLOCK]"`;

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3-8b-8192',
        max_tokens: 100,
        temperature: 0.4,
        messages: [{ role: 'system', content: system }, ...history]
      })
    });
    const d = await r.json();
    return d.choices?.[0]?.message?.content?.trim() || '';
  } catch (e) {
    console.error('[Groq error]', e.message);
    return 'Let me try connecting you now. [PASS]';
  }
}

// ── Helpers ───────────────────────────────────────────────────
const clean  = t => t.replace(/\[PASS\]|\[BLOCK\]/g, '').trim();
const isPass  = t => t.includes('[PASS]');
const isBlock = t => t.includes('[BLOCK]');
const now = () => new Date().toISOString();
const HOST = () => process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : 'https://stackborn-backend-production.up.railway.app';

// ═══════════════════════════════════════════════════════════════
//  VOICE ROUTES
// ═══════════════════════════════════════════════════════════════

// ── /incoming ── every call hits here first ───────────────────
app.post('/incoming', async (req, res) => {
  const { CallSid, From, To } = req.body;
  console.log(`[CALL] ${CallSid} from ${From}`);

  // Load user config
  const cfg = await fsGet('config', 'settings').catch(() => null);
  const userName   = cfg?.userName   || 'the person you called';
  const forwardTo  = cfg?.forwardTo  || '';

  // Init session
  sessions[CallSid] = {
    from: From, to: To,
    userName, forwardTo,
    history: [], turns: 0,
    start: now(), callerName: '', callerReason: ''
  };

  // Save initial record to Firebase
  await fsSet('calls', CallSid, {
    callSid: CallSid, from: From,
    startTime: sessions[CallSid].start,
    status: 'screening', verdict: 'pending',
    summary: '', transcript: '', callerName: ''
  });

  // Build TwiML — greet + listen
  const twiml = new VoiceResponse();
  const s = sessions[CallSid];

  // First AI greeting
  let greeting = '';
  try {
    greeting = await askGroq([{ role: 'user', content: 'Call just connected. Greet the caller.' }], userName);
    s.history.push({ role: 'assistant', content: greeting });
  } catch {
    greeting = `Hi! ${userName} is unavailable. I'm their AI assistant. Your name and reason please?`;
  }

  const g = twiml.gather({
    input: 'speech', action: `${HOST()}/gather`,
    method: 'POST', speechTimeout: 'auto',
    language: 'en-IN', timeout: 12
  });
  g.say({ voice: 'alice', language: 'en-IN' }, clean(greeting));
  twiml.redirect(`${HOST()}/no-input`);

  res.type('text/xml').send(twiml.toString());
});

// ── /gather ── processes caller speech ───────────────────────
app.post('/gather', async (req, res) => {
  const { CallSid, SpeechResult, From } = req.body;
  const twiml = new VoiceResponse();

  // Recover session if lost
  if (!sessions[CallSid]) {
    const cfg = await fsGet('config', 'settings').catch(() => null);
    sessions[CallSid] = {
      from: From, userName: cfg?.userName || 'the person',
      forwardTo: cfg?.forwardTo || '',
      history: [], turns: 0, start: now(),
      callerName: '', callerReason: ''
    };
  }

  const s = sessions[CallSid];

  if (!SpeechResult || SpeechResult.trim() === '') {
    // No speech — ask again once
    if (s.turns >= 2) {
      twiml.say({ voice: 'alice', language: 'en-IN' },
        `Sorry, I couldn't hear you. I'll let ${s.userName} know you called. Goodbye!`);
      twiml.hangup();
      await fsSet('calls', CallSid, {
        callSid: CallSid, from: s.from, startTime: s.start,
        status: 'completed', verdict: 'NO_RESPONSE',
        summary: 'Caller did not respond.', transcript: '', callerName: ''
      });
      return res.type('text/xml').send(twiml.toString());
    }
    const g = twiml.gather({
      input: 'speech', action: `${HOST()}/gather`,
      method: 'POST', speechTimeout: 'auto', language: 'en-IN', timeout: 10
    });
    g.say({ voice: 'alice', language: 'en-IN' }, "Sorry, I didn't catch that. Could you please say your name and reason?");
    s.turns++;
    return res.type('text/xml').send(twiml.toString());
  }

  s.turns++;
  s.history.push({ role: 'user', content: SpeechResult });
  if (!s.callerReason) s.callerReason = SpeechResult;

  // Get AI response
  const aiText = await askGroq(s.history, s.userName);
  s.history.push({ role: 'assistant', content: aiText });

  const spoken = clean(aiText);
  const transcript = s.history.map(h => `${h.role === 'assistant' ? 'AI' : 'Caller'}: ${h.content}`).join('\n');
  const summary = s.callerReason || SpeechResult;

  // Force block after 4 turns if no verdict
  const forceBlock = s.turns >= 4 && !isPass(aiText) && !isBlock(aiText);

  if (isPass(aiText)) {
    // ── PASS: announce + try to connect to user ──────────────
    twiml.say({ voice: 'alice', language: 'en-IN' },
      spoken || `Great! Let me connect you to ${s.userName} now. Please hold.`);

    if (s.forwardTo) {
      const dial = twiml.dial({
        callerId: TWILIO_NUM,
        timeout: 25,
        action: `${HOST()}/dial-status?callSid=${CallSid}&summary=${encodeURIComponent(summary)}&transcript=${encodeURIComponent(transcript)}`,
        method: 'POST'
      });
      dial.number(s.forwardTo);
    } else {
      twiml.say({ voice: 'alice', language: 'en-IN' },
        `${s.userName} is not reachable right now. I've noted your message and they'll call you back. Goodbye!`);
      twiml.hangup();
    }

    await fsSet('calls', CallSid, {
      callSid: CallSid, from: s.from, startTime: s.start,
      status: 'connecting', verdict: 'PASS',
      summary, transcript, callerName: s.callerName || ''
    });

  } else if (isBlock(aiText) || forceBlock) {
    // ── BLOCK: politely end ──────────────────────────────────
    twiml.say({ voice: 'alice', language: 'en-IN' },
      spoken || `Thank you for calling. ${s.userName} is unavailable for this type of call. Goodbye!`);
    twiml.hangup();

    await fsSet('calls', CallSid, {
      callSid: CallSid, from: s.from, startTime: s.start,
      status: 'completed', verdict: 'BLOCK',
      summary, transcript, callerName: s.callerName || ''
    });

  } else {
    // ── Continue conversation ────────────────────────────────
    const g = twiml.gather({
      input: 'speech', action: `${HOST()}/gather`,
      method: 'POST', speechTimeout: 'auto',
      language: 'en-IN', timeout: 10
    });
    g.say({ voice: 'alice', language: 'en-IN' }, spoken || 'Could you tell me a bit more?');
    twiml.redirect(`${HOST()}/no-input`);
  }

  res.type('text/xml').send(twiml.toString());
});

// ── /dial-status ── fires after forwarded call ends ──────────
app.post('/dial-status', async (req, res) => {
  const { DialCallStatus, callSid } = { ...req.body, ...req.query };
  const twiml = new VoiceResponse();
  const s = sessions[callSid] || {};
  const summary  = decodeURIComponent(req.query.summary  || '');
  const transcript = decodeURIComponent(req.query.transcript || '');

  if (DialCallStatus === 'completed') {
    // User picked up and call was connected ✅
    await fsSet('calls', callSid, {
      callSid, from: s.from || '', startTime: s.start || now(),
      status: 'completed', verdict: 'PASS',
      summary: `Connected. ${summary}`, transcript,
      callerName: s.callerName || ''
    });
    twiml.hangup();
  } else {
    // User didn't answer — take a message
    twiml.say({ voice: 'alice', language: 'en-IN' },
      `${s.userName || 'They'} couldn't answer right now. Please leave your message after the beep and they'll call you back.`);
    twiml.record({
      action: `${HOST()}/recording?callSid=${callSid}`,
      method: 'POST', maxLength: 60, timeout: 5,
      transcribe: true,
      transcribeCallback: `${HOST()}/transcription?callSid=${callSid}`
    });

    await fsSet('calls', callSid, {
      callSid, from: s.from || '', startTime: s.start || now(),
      status: 'voicemail', verdict: 'PASS',
      summary: `Voicemail left. ${summary}`, transcript,
      callerName: s.callerName || ''
    });
  }

  res.type('text/xml').send(twiml.toString());
});

// ── /recording ── after voicemail recorded ───────────────────
app.post('/recording', async (req, res) => {
  const { RecordingUrl, callSid } = { ...req.body, ...req.query };
  if (callSid && RecordingUrl) {
    await fsSet('calls', callSid, { recordingUrl: RecordingUrl, status: 'voicemail_recorded' });
  }
  const twiml = new VoiceResponse();
  twiml.say({ voice: 'alice', language: 'en-IN' }, 'Thank you for your message. Goodbye!');
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});

// ── /transcription ── Twilio auto-transcribes voicemail ──────
app.post('/transcription', async (req, res) => {
  const { TranscriptionText, callSid } = { ...req.body, ...req.query };
  if (callSid && TranscriptionText) {
    await fsSet('calls', callSid, { voicemailText: TranscriptionText });
  }
  res.sendStatus(200);
});

// ── /no-input ── caller went silent ─────────────────────────
app.post('/no-input', async (req, res) => {
  const { CallSid } = req.body;
  const s = sessions[CallSid];
  const twiml = new VoiceResponse();
  twiml.say({ voice: 'alice', language: 'en-IN' },
    `I'll let ${s?.userName || 'them'} know you called. Goodbye!`);
  twiml.hangup();
  if (CallSid) {
    await fsSet('calls', CallSid, {
      callSid: CallSid, from: s?.from || '',
      startTime: s?.start || now(),
      status: 'completed', verdict: 'NO_RESPONSE',
      summary: 'Caller went silent.', transcript: ''
    });
  }
  res.type('text/xml').send(twiml.toString());
});

// ═══════════════════════════════════════════════════════════════
//  API ROUTES (for dashboard)
// ═══════════════════════════════════════════════════════════════

// Get all calls
app.get('/calls', async (req, res) => {
  try {
    const calls = await fsList('calls');
    calls.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
    res.json(calls);
  } catch (e) { res.json([]); }
});

// Get / set profile
app.get('/profile', async (req, res) => {
  const cfg = await fsGet('config', 'settings').catch(() => null);
  res.json(cfg || { forwardTo: '', userName: '' });
});

app.post('/profile', async (req, res) => {
  const { forwardTo, userName } = req.body;
  if (!forwardTo) return res.status(400).json({ error: 'forwardTo required' });
  await fsSet('config', 'settings', { forwardTo, userName: userName || 'the user' });
  res.json({ ok: true, forwardTo, userName });
});

// Trigger outbound test call
app.post('/test-call', async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'to required' });
  try {
    const call = await twilioClient.calls.create({
      to, from: TWILIO_NUM,
      url: `${HOST()}/incoming`,
      method: 'POST'
    });
    res.json({ ok: true, callSid: call.sid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Health
app.get('/', (_, res) => res.json({ ok: true, app: 'Stackborn AI', version: '2.0.0', status: 'production' }));

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🤖 Stackborn AI v2 running on :${PORT}`));
