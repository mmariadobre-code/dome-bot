const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const app = express();
app.use(express.json());

const VERIFY_TOKEN   = process.env.VERIFY_TOKEN;
const PAGE_TOKEN     = process.env.PAGE_TOKEN;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const SHEET_ID       = process.env.SHEET_ID;

let GOOGLE_CREDS = {};
try {
  GOOGLE_CREDS = JSON.parse(process.env.GOOGLE_CREDS || '{}');
} catch(e) {
  console.log('GOOGLE_CREDS parse error:', e.message);
}

const SYSTEM_PROMPT = `Sei l'assistente virtuale di The DŌME Studio, uno studio di Pilates Reformer premium in apertura a San Lazzaro di Savena (Zona 051, Bologna).

INFORMAZIONI:
- Zona 051, San Lazzaro di Savena, Bologna
- Pilates Reformer
- In apertura, non ancora aperto
- Pacchetto pre-apertura: 8 lezioni 240€ entro 30 giorni
- Prima dell'apertura ci saranno altri pacchetti

REGOLE:
- Rispondi sempre in italiano
- Tono caldo e professionale
- Risposte brevi (max 3-4 frasi)
- Niente elenchi puntati
- Non promettere date di apertura

LISTA D'ATTESA:
Quando qualcuno vuole essere contattato: chiedi nome e cognome, poi telefono, poi conferma.`;

const conv = {};

async function salvaSheet(nome, tel, sid) {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: GOOGLE_CREDS,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const sheets = google.sheets({ version: 'v4', auth });
    const data = new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' });
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: 'Lista!A:D',
      valueInputOption: 'RAW',
      requestBody: { values: [[data, nome, tel, sid]] },
    });
    console.log('Salvato:', nome, tel);
  } catch(e) {
    console.log('Sheets error:', e.message);
  }
}

async function claude(msgs) {
  const r = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-3-5-haiku-20241022',
    max_tokens: 400,
    system: SYSTEM_PROMPT,
    messages: msgs,
  }, {
    headers: {
      'x-api-key': CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
  });
  return r.data.content[0].text;
}

async function send(sid, text) {
  await axios.post(
    `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_TOKEN}`,
    { recipient: { id: sid }, message: { text } }
  );
}

app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === VERIFY_TOKEN) {
    res.send(req.query['hub.challenge']);
  } else res.sendStatus(403);
});

app.get('/', (req, res) => res.send('The DOME Studio Bot is running!'));

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const entry = req.body?.entry?.[0]?.messaging?.[0];
    if (!entry?.message?.text) return;

    const sid = entry.sender.id;
    const txt = entry.message.text.trim();

    if (!conv[sid]) conv[sid] = { msgs: [], fase: 'chat', dati: {} };
    const c = conv[sid];
    c.msgs.push({ role: 'user', content: txt });

    if (c.fase === 'attendi_nome') {
      c.dati.nome = txt;
      c.fase = 'attendi_tel';
      const r = `Perfetto ${txt}! 😊 E il tuo numero di telefono?`;
      c.msgs.push({ role: 'assistant', content: r });
      await send(sid, r);
      return;
    }

    if (c.fase === 'attendi_tel') {
      c.dati.tel = txt;
      c.fase = 'done';
      await salvaSheet(c.dati.nome, txt, sid);
      const r = `Ottimo! Ho inserito ${c.dati.nome} nella lista ✨ Ti contatteremo appena avremo novità. A presto!`;
      c.msgs.push({ role: 'assistant', content: r });
      await send(sid, r);
      return;
    }

    const r = await claude(c.msgs);
    c.msgs.push({ role: 'assistant', content: r });

    if (r.toLowerCase().includes('nome') && c.fase === 'chat') {
      c.fase = 'attendi_nome';
    }

    await send(sid, r);
  } catch(e) {
    console.log('Error:', e.message, JSON.stringify(e.response?.data));
    try {
      const sid = req.body?.entry?.[0]?.messaging?.[0]?.sender?.id;
      if (sid) await send(sid, 'Scusa, problema tecnico momentaneo. Riprova! 🙏');
    } catch(_) {}
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Bot in ascolto sulla porta', PORT));





