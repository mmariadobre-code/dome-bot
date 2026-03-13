const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const app = express();
app.use(express.json());

const VERIFY_TOKEN    = process.env.VERIFY_TOKEN;
const PAGE_TOKEN      = process.env.PAGE_TOKEN;
const CLAUDE_API_KEY  = process.env.CLAUDE_API_KEY;
const SHEET_ID        = process.env.SHEET_ID;
const GOOGLE_CREDS    = JSON.parse(process.env.GOOGLE_CREDS || '{}');

const SYSTEM_PROMPT = `Sei l'assistente virtuale di The DŌME Studio, uno studio di Pilates Reformer premium in apertura a San Lazzaro di Savena (Zona 051, Bologna).

INFORMAZIONI SULLO STUDIO:
- Nome: The DŌME Studio
- Zona: 051 — San Lazzaro di Savena, Bologna
- Disciplina: Pilates Reformer
- Stato: in apertura (non ancora aperto)
- Pacchetto pre-apertura: 8 lezioni a 240€, utilizzabili entro 30 giorni
- Prima dell'apertura ci saranno altre tipologie di pacchetti

ISTRUZIONI:
- Rispondi sempre in italiano
- Tono caldo, professionale, conciso (max 3-4 frasi per messaggio)
- Non usare elenchi puntati, scrivi in modo conversazionale
- Non promettere date di apertura specifiche

FLUSSO LISTA D'ATTESA:
Quando la persona esprime interesse a essere contattata:
1. Chiedi nome e cognome
2. Chiedi il numero di telefono
3. Conferma che la contatterai all'apertura`;

const conversazioni = {};

async function salvaInSheet(nome, telefono, senderId) {
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
      requestBody: { values: [[data, nome, telefono, senderId]] },
    });
    console.log(`Salvato: ${nome} — ${telefono}`);
  } catch (err) {
    console.error('Errore Google Sheets:', err.message);
  }
}

async function chiediAClaude(messaggi) {
  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-opus-4-5',
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: messaggi,
    },
    {
      headers: {
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
    }
  );
  return res.data.content[0].text;
}

async function inviaMess(senderId, testo) {
  await axios.post(
    `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_TOKEN}`,
    { recipient: { id: senderId }, message: { text: testo } }
  );
}

app.get('/webhook', (req, res) => {
  if (req.query['hub.verify_token'] === VERIFY_TOKEN) {
    res.send(req.query['hub.challenge']);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const entry = req.body?.entry?.[0]?.messaging?.[0];
  if (!entry?.message?.text) return;

  const senderId = entry.sender.id;
  const testo = entry.message.text.trim();

  if (!conversazioni[senderId]) {
    conversazioni[senderId] = { messaggi: [], fase: 'chat', dati: {} };
  }
  const conv = conversazioni[senderId];
  conv.messaggi.push({ role: 'user', content: testo });

  try {
    if (conv.fase === 'attendi_nome') {
      conv.dati.nome = testo;
      conv.fase = 'attendi_telefono';
      const risposta = `Perfetto ${testo}! 😊 E il tuo numero di telefono? Ti contatteremo lì appena siamo pronti ad aprire.`;
      conv.messaggi.push({ role: 'assistant', content: risposta });
      await inviaMess(senderId, risposta);
      return;
    }

    if (conv.fase === 'attendi_telefono') {
      conv.dati.telefono = testo;
      conv.fase = 'completato';
      await salvaInSheet(conv.dati.nome, conv.dati.telefono, senderId);
      const risposta = `Ottimo! Ho inserito ${conv.dati.nome} (${testo}) nella nostra lista ✨ Ti contatteremo appena avremo novità sull'apertura. A presto!`;
      conv.messaggi.push({ role: 'assistant', content: risposta });
      await inviaMess(senderId, risposta);
      return;
    }

    const risposta = await chiediAClaude(conv.messaggi);
    conv.messaggi.push({ role: 'assistant', content: risposta });

    const triggerLista = ['nome e cognome', 'come ti chiami', 'qual è il tuo nome', 'lista d\'attesa'];
    if (triggerLista.some(t => risposta.toLowerCase().includes(t)) && conv.fase === 'chat') {
      conv.fase = 'attendi_nome';
    }

    await inviaMess(senderId, risposta);
  } catch (err) {
    console.error('Errore:', err.message);
    await inviaMess(senderId, 'Scusa, si è verificato un piccolo problema tecnico. Riprova tra un momento!');
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log('The DOME Studio Bot — in ascolto sulla porta', process.env.PORT || 3000);

});
