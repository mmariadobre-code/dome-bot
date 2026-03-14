const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_TOKEN = process.env.PAGE_TOKEN;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const SHEET_ID = process.env.SHEET_ID;

let GOOGLE_CREDS = {};
try {
  GOOGLE_CREDS = JSON.parse(process.env.GOOGLE_CREDS || '{}');
} catch (e) {
  console.log('GOOGLE_CREDS parse error:', e.message);
}

const SYSTEM_PROMPT = `
Sei l'assistente virtuale di The DŌME Studio, uno studio di Pilates Reformer premium in apertura a San Lazzaro di Savena, zona 051 Bologna.

Informazioni certe:
- Lo studio è in apertura, non ancora aperto
- Sarà dedicato esclusivamente al Pilates Reformer
- Lezione di gruppo Reformer: 35€ a persona
- Lezione Duo: 40€ a persona
- Lezione individuale: 70€
- Ci saranno anche pacchetti più convenienti, ad esempio 8 lezioni a 240€, da utilizzare entro 30 giorni dall’attivazione
- Prima dell’apertura potranno esserci anche altri pacchetti
- Non dare mai date certe di apertura se non sono esplicitamente confermate
- La posizione precisa sarà comunicata più avanti

Regole di risposta:
- Rispondi sempre in italiano
- Tono caldo, elegante e professionale
- Risposte brevi
- Non inventare informazioni
`;

const conv = {};

function isGreeting(text) {
  const t = (text || '').toLowerCase().trim();
  return ['ciao', 'salve', 'hey', 'buongiorno', 'buonasera', 'hello'].includes(t);
}

function isLikelyWaitlistRequest(text) {
  const t = (text || '').toLowerCase();
  const keywords = [
    'lista',
    "lista d'attesa",
    'lista d’attesa',
    'attesa',
    'ricontatt',
    'contattami',
    'aggiornatemi',
    'fatemi sapere',
    'fammi sapere',
    'novità',
    'quando aprite',
    'quando aprirete',
    'interessata',
    'interessato',
    'mi interessa',
    'sono interessata',
    'sono interessato'
  ];
  return keywords.some(k => t.includes(k));
}

function isGetStartedText(text) {
  const t = (text || '').toLowerCase().trim();
  return t === 'get started' || t === 'inizia';
}

async function salvaSheet(nome, tel, sid) {
  try {
    if (!SHEET_ID) throw new Error('SHEET_ID mancante');
    if (!GOOGLE_CREDS || Object.keys(GOOGLE_CREDS).length === 0) {
      throw new Error('GOOGLE_CREDS mancanti o non validi');
    }

    const auth = new google.auth.GoogleAuth({
      credentials: GOOGLE_CREDS,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const sheets = google.sheets({ version: 'v4', auth });

    const data = new Date().toLocaleString('it-IT', {
      timeZone: 'Europe/Rome',
    });

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Lista!A:D',
      valueInputOption: 'RAW',
      requestBody: {
        values: [[data, nome, tel, sid]],
      },
    });

    console.log('Salvato su Google Sheets:', { nome, tel, sid });
  } catch (e) {
    console.log('Sheets error:', e.message);
  }
}

async function claude(msgs) {
  if (!CLAUDE_API_KEY) throw new Error('CLAUDE_API_KEY mancante');

  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-3-haiku-20240307',
      max_tokens: 200,
      system: SYSTEM_PROMPT,
      messages: msgs,
    },
    {
      headers: {
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      timeout: 30000,
    }
  );

  return response.data.content[0].text;
}

async function sendText(sid, text) {
  const r = await axios.post(
    `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_TOKEN}`,
    {
      recipient: { id: sid },
      message: { text }
    },
    { timeout: 30000 }
  );
  console.log('sendText ok:', r.status);
}

async function sendQuickReplies(sid, text) {
  const r = await axios.post(
    `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_TOKEN}`,
    {
      recipient: { id: sid },
      message: {
        text,
        quick_replies: [
          { content_type: 'text', title: '💫 Prezzi', payload: 'PREZZI' },
          { content_type: 'text', title: '📍 Dove siamo', payload: 'DOVE' },
          { content_type: 'text', title: '🤎 Lista attesa', payload: 'LISTA' },
          { content_type: 'text', title: '🤍 Lo studio', payload: 'STUDIO' }
        ]
      }
    },
    { timeout: 30000 }
  );
  console.log('sendQuickReplies ok:', r.status);
}

async function sendMainMenu(sid) {
  const text =
`Ciao e benvenuta in The DŌME Studio ✨

Sono felicissima di aiutarti 🤍

Stiamo creando uno spazio dedicato al Pilates Reformer, pensato per offrire un’esperienza elegante, curata e accogliente.

Se vuoi puoi scoprire qualcosa in più qui sotto 💅`;

  await sendQuickReplies(sid, text);
}

app.get('/', (req, res) => {
  res.json({
    ok: true,
    message: 'The DŌME Studio Bot is running'
  });
});

app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === VERIFY_TOKEN) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  return res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    console.log('WEBHOOK:', JSON.stringify(req.body, null, 2));

    const entry = req.body?.entry?.[0]?.messaging?.[0];
    if (!entry) return;

    const sid = entry?.sender?.id;
    const txt = entry?.message?.text?.trim();
    const quick = entry?.message?.quick_reply?.payload;
    const postback = entry?.postback?.payload;

    console.log('sid:', sid);
    console.log('txt:', txt);
    console.log('quick:', quick);
    console.log('postback:', postback);

    if (!sid) return;

    if (!conv[sid]) {
      conv[sid] = { msgs: [], fase: 'chat', dati: {} };
    }

    const c = conv[sid];

    // GET_STARTED come postback classico
    if (postback === 'GET_STARTED') {
      await sendMainMenu(sid);
      return;
    }

    // GET_STARTED come testo in alcune interfacce/client
    if (isGetStartedText(txt)) {
      await sendMainMenu(sid);
      return;
    }

    const userText = txt || quick;
    if (!userText) return;

    if (c.fase === 'attendi_nome') {
      c.dati.nome = userText;
      c.fase = 'attendi_tel';

      await sendText(
        sid,
        `Che piacere ${userText} 💅\nMi lasci anche il tuo numero di telefono così possiamo ricontattarti appena avremo novità?`
      );
      return;
    }

    if (c.fase === 'attendi_tel') {
      c.dati.tel = userText;
      c.fase = 'done';

      await salvaSheet(c.dati.nome, userText, sid);

      await sendText(
        sid,
        `Perfetto, ti abbiamo inserita nella lista d’attesa 🤎\nTi contatteremo appena avremo novità sull’apertura.\n\nA presto 💅`
      );
      return;
    }

    if (quick === 'PREZZI') {
      await sendQuickReplies(
        sid,
        `Queste saranno le tariffe indicative di The DŌME Studio ✨

• Lezione di gruppo Reformer: 35€
• Lezione Duo: 40€
• Lezione individuale: 70€

Per chi desidera allenarsi con regolarità ci saranno anche pacchetti più convenienti, ad esempio 8 lezioni a 240€ 🤎

Prima dell’apertura verranno presentati anche altri pacchetti dedicati ✨`
      );
      return;
    }

    if (quick === 'DOVE') {
      await sendQuickReplies(
        sid,
        `The DŌME Studio aprirà a San Lazzaro di Savena, zona 051 Bologna 📍

La posizione precisa sarà comunicata più avanti 🤍`
      );
      return;
    }

    if (quick === 'STUDIO') {
      await sendQuickReplies(
        sid,
        `The DŌME Studio sarà uno spazio dedicato esclusivamente al Pilates Reformer.

Un ambiente intimo, elegante e curato, pensato per offrire un’esperienza premium 🤍`
      );
      return;
    }

    if (quick === 'LISTA') {
      c.fase = 'attendi_nome';
      await sendText(
        sid,
        `Con molto piacere ✨\nPer inserirti in lista d’attesa mi lasci nome e cognome?`
      );
      return;
    }

    if (isGreeting(userText)) {
      await sendMainMenu(sid);
      return;
    }

    if (isLikelyWaitlistRequest(userText)) {
      c.fase = 'attendi_nome';
      await sendText(
        sid,
        `Con piacere ✨\nPer inserirti in lista d’attesa mi lasci nome e cognome?`
      );
      return;
    }

    c.msgs.push({ role: 'user', content: userText });
    const reply = await claude(c.msgs);
    c.msgs.push({ role: 'assistant', content: reply });

    await sendQuickReplies(sid, reply);

  } catch (e) {
    console.log('===== BOT ERROR =====');
    console.log('Message:', e.message);
    console.log('Status:', e.response?.status || 'n/a');
    console.log('Data:', JSON.stringify(e.response?.data || {}, null, 2));

    try {
      const sid = req.body?.entry?.[0]?.messaging?.[0]?.sender?.id;
      if (sid) {
        await sendText(
          sid,
          'Scusa, c’è stato un piccolo problema tecnico 🙏 Riprova tra poco.'
        );
      }
    } catch (sendError) {
      console.log('Send fallback error:', sendError.message);
    }
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log('Bot avviato sulla porta', PORT);
});
