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
- Tono caldo, elegante, professionale e accogliente
- Risposte brevi, massimo 3-4 frasi
- Non usare elenchi puntati, a meno che non serva per spiegare chiaramente i prezzi
- Non inventare informazioni
- Se una persona vuole essere ricontattata, iscriversi, lasciare il contatto, entrare in lista d'attesa o avere novità sull'apertura, chiedi nome e cognome in modo naturale
- Mantieni uno stile premium, delicato e curato

Obiettivo:
- Rispondere alle domande sullo studio
- Accompagnare con gentilezza chi vuole entrare in lista d’attesa
- Far percepire il brand come esclusivo, raffinato e accogliente
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
    'essere contattato',
    'mi interessa',
    'sono interessata',
    'sono interessato'
  ];

  return keywords.some(k => t.includes(k));
}

function isGreeting(text) {
  const t = (text || '').toLowerCase().trim();
  const greetings = [
    'ciao',
    'salve',
    'hey',
    'buongiorno',
    'buonasera',
    'hello'
  ];
  return greetings.includes(t);
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

async function sendText(sid, text) {
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

async function sendQuickReplies(sid, text) {
  if (!PAGE_TOKEN) {
    throw new Error('PAGE_TOKEN mancante');
  }

  await axios.post(
    `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_TOKEN}`,
    {
      recipient: { id: sid },
      message: {
        text,
        quick_replies: [
          {
            content_type: 'text',
            title: '💫 Prezzi',
            payload: 'PREZZI'
          },
          {
            content_type: 'text',
            title: '📍 Dove siamo',
            payload: 'DOVE_SIAMO'
          },
          {
            content_type: 'text',
            title: '🤎 Lista attesa',
            payload: 'LISTA_ATTESA'
          },
          {
            content_type: 'text',
            title: '🤍 Lo studio',
            payload: 'COME_FUNZIONA'
          }
        ]
      },
    },
    {
      timeout: 30000,
    }
  );
}

async function sendMainMenu(sid) {
  const text =
    'Ciao e benvenuta in The DŌME Studio ✨\n' +
    'Sono felicissima di aiutarti 🤍\n' +
    'Sarà uno spazio dedicato al Pilates Reformer, pensato per offrire un’esperienza curata, elegante e accogliente.\n' +
    'Se vuoi, puoi scoprire qualcosa in più qui sotto 💅';

  await sendQuickReplies(sid, text);
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
    const entry = req.body?.entry?.[0]?.messaging?.[0];
    if (!entry) return;

    const sid = entry?.sender?.id;
    const txt = entry?.message?.text?.trim();
    const payload = entry?.message?.quick_reply?.payload;

    if (!sid) return;

    const userText = txt || payload;
    if (!userText) return;

    if (!conv[sid]) {
      conv[sid] = {
        msgs: [],
        fase: 'chat',
        dati: {},
      };
    }

    const c = conv[sid];

    if (c.fase === 'attendi_nome') {
      c.dati.nome = userText;
      c.fase = 'attendi_tel';

      const reply =
        `Che piacere ${userText} 💅\n` +
        `Mi lasci anche il tuo numero di telefono così possiamo ricontattarti appena avremo novità?`;

      c.msgs.push({ role: 'assistant', content: reply });
      await sendText(sid, reply);
      return;
    }

    if (c.fase === 'attendi_tel') {
      c.dati.tel = userText;
      c.fase = 'done';

      await salvaSheet(c.dati.nome, userText, sid);

      const reply =
        'Perfetto, ti abbiamo inserita nella lista d’attesa 🤎\n' +
        'Ti contatteremo appena avremo novità sull’apertura e sui pacchetti dedicati.\n' +
        'A presto 💅';

      c.msgs.push({ role: 'assistant', content: reply });
      await sendText(sid, reply);
      return;
    }

    if (payload === 'PREZZI') {
      const reply =
        'Queste saranno le tariffe indicative di The DŌME Studio ✨\n\n' +
        '• Lezione di gruppo Reformer: 35€ a persona\n' +
        '• Lezione Duo, se desideri allenarti con un’amica: 40€ a persona\n' +
        '• Lezione individuale: 70€\n\n' +
        'Per chi desidera allenarsi con regolarità ci saranno anche pacchetti più convenienti, ad esempio 8 lezioni a 240€, da utilizzare entro 30 giorni dall’attivazione 🤎\n\n' +
        'Prima dell’apertura verranno comunque presentati anche altri pacchetti dedicati ✨';

      c.msgs.push({ role: 'assistant', content: reply });
      await sendQuickReplies(sid, reply);
      return;
    }

    if (payload === 'DOVE_SIAMO') {
      const reply =
        'The DŌME Studio aprirà a San Lazzaro di Savena, in zona 051 Bologna 📍\n' +
        'La posizione precisa sarà comunicata più avanti 🤍';

      c.msgs.push({ role: 'assistant', content: reply });
      await sendQuickReplies(sid, reply);
      return;
    }

    if (payload === 'COME_FUNZIONA') {
      const reply =
        'The DŌME Studio sarà uno spazio dedicato esclusivamente al Pilates Reformer, con un’atmosfera curata e un approccio premium 🤍\n' +
        'L’idea è offrire un’esperienza intima, elegante e su misura ✨';

      c.msgs.push({ role: 'assistant', content: reply });
      await sendQuickReplies(sid, reply);
      return;
    }

    if (payload === 'LISTA_ATTESA') {
      c.fase = 'attendi_nome';

      const reply =
        'Con molto piacere ✨\n' +
        'Per inserirti in lista d’attesa mi lasci nome e cognome?';

      c.msgs.push({ role: 'assistant', content: reply });
      await sendText(sid, reply);
      return;
    }

    if (c.fase === 'chat' && isGreeting(userText)) {
      await sendMainMenu(sid);
      return;
    }

    if (c.fase === 'chat' && isLikelyWaitlistRequest(userText)) {
      c.fase = 'attendi_nome';

      const reply =
        'Con piacere ✨\n' +
        'Per inserirti in lista d’attesa mi lasci nome e cognome?';

      c.msgs.push({ role: 'assistant', content: reply });
      await sendText(sid, reply);
      return;
    }

    c.msgs.push({ role: 'user', content: userText });

    const reply = await claude(c.msgs);
    c.msgs.push({ role: 'assistant', content: reply });

    if (c.fase === 'chat' && reply.toLowerCase().includes('nome e cognome')) {
      c.fase = 'attendi_nome';
      await sendText(sid, reply);
      return;
    }

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
          'Scusa, c’è stato un piccolo problema tecnico momentaneo 🙏 Riprova tra poco.'
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



