const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PAGE_TOKEN = process.env.PAGE_TOKEN;

app.get('/', (req, res) => {
  res.json({
    status: "bot running",
    hasVerifyToken: !!VERIFY_TOKEN,
    hasPageToken: !!PAGE_TOKEN
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
    console.log("WEBHOOK BODY:", JSON.stringify(req.body, null, 2));

    const entry = req.body?.entry?.[0]?.messaging?.[0];
    if (!entry) {
      console.log("No entry");
      return;
    }

    const senderId = entry.sender.id;
    const text = entry.message?.text;

    console.log("Sender:", senderId);
    console.log("Text:", text);

    if (!text) return;

    await axios.post(
      `https://graph.facebook.com/v19.0/me/messages?access_token=${PAGE_TOKEN}`,
      {
        recipient: { id: senderId },
        message: { text: "TEST OK ✅" }
      }
    );

    console.log("Message sent");
  } catch (e) {
    console.log("ERROR:", e.message);
    console.log("STATUS:", e.response?.status);
    console.log("DATA:", JSON.stringify(e.response?.data, null, 2));
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Bot running on port", PORT);
  console.log("VERIFY_TOKEN:", !!VERIFY_TOKEN);
  console.log("PAGE_TOKEN:", !!PAGE_TOKEN);
});



