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
- Sarà dedicato al Pilates Reformer
- Pacchetto pre-apertura: 8 lezioni a 240€, utilizzabili entro 30 giorni
- Prima dell'apertura potranno esserci anche altri pacchetti
- Non dare mai date certe di apertura se non sono esplicitamente confermate

Regole di risposta:
- Rispondi sempre in italiano
- Tono caldo, curato e professionale
- Risposte brevi, massimo 3-4 frasi
- Non usare elenchi puntati
- Non inventare informazioni
- Se una persona vuole essere ricontattata, iscriversi, lasciare il contatto, entrare in lista d'attesa o avere novità sull'apertura, chiedi il nome e cognome in modo naturale

Obiettivo:
- Rispondere alle domande sullo studio
- Accompagnare con gentilezza chi vuole entrare in lista d’attesa
`;

const conv = {};

function isLikelyWaitlistRequest(text) {
  const t = (text || '').toLowerCase();

  const keywords = [
    'lista',
    "lista d'attesa",
    'lista d’attesa',
    'attesa',
    'ricontatt',
    'contattatemi',
    'contattami',
    'tenetemi aggiornata',
    'tenetemi aggiornato',
    'aggiornatemi',
    'fatemi sapere',
    'fammi sapere',
    'novità',
    'notizie',
    'quando aprite',
    'quando aprirete',
    'interessata',
    'interessato',
    'vorrei iscrivermi',
    'voglio iscrivermi',
    'prenotarmi',
    'prenotare',
    'lasciare il numero',
    'lascio il numero',
    'essere contattata',
    'essere contattato'
  ];

  return keywords.some(k => t.includes(k));
}

async function salvaSheet(nome, tel, sid) {
  try {
    if (!SHEET_ID) {
      throw new Error('SHEET_ID mancante');
    }

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
  if (!CLAUDE_API_KEY) {
    throw new Error('CLAUDE_API_KEY mancante');
  }

  console.log('Invio richiesta a Claude...');

  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-haiku-4-5',
      max_tokens: 180,
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

  console.log('Claude status OK');

  const blocks = response?.data?.content || [];
  const text = blocks
    .filter(block => block.type === 'text' && block.text)
    .map(block => block.text)
    .join('\n')
    .trim();

  if (!text) {
    throw new Error('Risposta Claude vuota o non valida');
  }

  return text;
}

async function send(sid, text) {
  if (!PAGE_TOKEN) {
    throw new Error('PAGE_TOKEN mancante');
  }

  await axios.post(
    `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_TOKEN}`,
    {
      recipient: { id: sid },
      message: { text },
    },
    {
      timeout: 30000,
    }
  );
}

app.get('/', (req, res) => {
  res.json({
    ok: true,
    message: 'The DŌME Studio Bot is running!',
    env: {
      hasVerifyToken: !!VERIFY_TOKEN,
      hasPageToken: !!PAGE_TOKEN,
      hasClaudeKey: !!CLAUDE_API_KEY,
      hasSheetId: !!SHEET_ID,
      hasGoogleCreds: !!(GOOGLE_CREDS && Object.keys(GOOGLE_CREDS).length > 0),
    },
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
    console.log('WEBHOOK BODY:', JSON.stringify(req.body, null, 2));

    const entry = req.body?.entry?.[0]?.messaging?.[0];
    if (!entry) return;

    const sid = entry?.sender?.id;
    const txt = entry?.message?.text?.trim();

    console.log('SID:', sid);
    console.log('TXT:', txt);

    if (!sid || !txt) return;

    if (!conv[sid]) {
      conv[sid] = {
        msgs: [],
        fase: 'chat',
        dati: {},
      };
    }

    const c = conv[sid];
    c.msgs.push({ role: 'user', content: txt });

    if (c.fase === 'attendi_nome') {
      c.dati.nome = txt;
      c.fase = 'attendi_tel';

      const reply = `Perfetto ${txt} ✨ Mi lasci anche il tuo numero di telefono così possiamo ricontattarti appena avremo novità?`;
      c.msgs.push({ role: 'assistant', content: reply });
      await send(sid, reply);
      return;
    }

    if (c.fase === 'attendi_tel') {
      c.dati.tel = txt;
      c.fase = 'done';

      await salvaSheet(c.dati.nome, txt, sid);

      const reply = `Perfetto, ti abbiamo inserita nella lista d’attesa ✨ Ti contatteremo appena avremo novità sull’apertura. A presto!`;
      c.msgs.push({ role: 'assistant', content: reply });
      await send(sid, reply);
      return;
    }

    if (c.fase === 'chat' && isLikelyWaitlistRequest(txt)) {
      c.fase = 'attendi_nome';
      const reply = `Con piacere ✨ Per inserirti in lista d’attesa mi lasci nome e cognome?`;
      c.msgs.push({ role: 'assistant', content: reply });
      await send(sid, reply);
      return;
    }

    const reply = await claude(c.msgs);
    c.msgs.push({ role: 'assistant', content: reply });

    if (c.fase === 'chat' && reply.toLowerCase().includes('nome e cognome')) {
      c.fase = 'attendi_nome';
    }

    await send(sid, reply);
  } catch (e) {
    console.log('===== BOT ERROR =====');
    console.log('Message:', e.message);
    console.log('Status:', e.response?.status || 'n/a');
    console.log('Data:', JSON.stringify(e.response?.data || {}, null, 2));

    try {
      const sid = req.body?.entry?.[0]?.messaging?.[0]?.sender?.id;
      if (sid) {
        await send(
          sid,
          'Scusa, c’è stato un piccolo problema tecnico momentaneo. Riprova tra poco 🙏'
        );
      }
    } catch (sendError) {
      console.log('Send fallback error:', sendError.message);
    }
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log('Bot in ascolto sulla porta', PORT);
  console.log('VERIFY_TOKEN loaded:', !!VERIFY_TOKEN);
  console.log('PAGE_TOKEN loaded:', !!PAGE_TOKEN);
  console.log('CLAUDE_API_KEY loaded:', !!CLAUDE_API_KEY);
  console.log('SHEET_ID loaded:', !!SHEET_ID);
  console.log(
    'GOOGLE_CREDS loaded:',
    !!(GOOGLE_CREDS && Object.keys(GOOGLE_CREDS).length > 0)
  );
});




