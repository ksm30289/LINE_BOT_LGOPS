import express from "express";
import line from "@line/bot-sdk";
import OpenAI from "openai";

const app = express();

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: lineConfig.channelAccessToken,
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

app.get("/", (req, res) => {
  res.send("LGOps LINE Bot is running!");
});

app.post("/webhook", line.middleware(lineConfig), async (req, res) => {
  try {
    const events = req.body.events;
    await Promise.all(events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error(err);
    res.status(500).end();
  }
});

async function handleEvent(event) {
  if (event.type !== "message" || event.message.type !== "text") {
    return;
  }

  const userMessage = event.message.text;

  const completion = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [
      {
        role: "system",
        content: "너는 게임 운영자를 돕는 친절한 LINE 챗봇이다. 한국어로 짧고 명확하게 답변한다."
      },
      {
        role: "user",
        content: userMessage
      }
    ],
  });

  const replyText = completion.choices[0].message.content || "답변을 만들지 못했어요.";

  await client.replyMessage({
    replyToken: event.replyToken,
    messages: [
      {
        type: "text",
        text: replyText.slice(0, 4900),
      },
    ],
  });
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
