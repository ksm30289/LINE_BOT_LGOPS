import express from "express";
import * as line from "@line/bot-sdk";
import OpenAI from "openai";
import cron from "node-cron";
import { google } from "googleapis";

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

const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const JIRA_SHEET_NAME = process.env.JIRA_SHEET_NAME;
const STATE_SHEET_NAME = "BOT_STATE";
const ALERT_TARGET_ID = process.env.JIRA_ALERT_TARGET_ID;

const JIRA_KEY_COLUMN = process.env.JIRA_KEY_COLUMN || "H";
const JIRA_TITLE_COLUMN = process.env.JIRA_TITLE_COLUMN || "E";
const JIRA_STATUS_COLUMN = process.env.JIRA_STATUS_COLUMN || "J";
const JIRA_LINK_COLUMN = process.env.JIRA_LINK_COLUMN || "H";
const JIRA_TYPE_COLUMN = process.env.JIRA_TYPE_COLUMN || "A";
const JIRA_ASSIGNEE_COLUMN = process.env.JIRA_ASSIGNEE_COLUMN || "I";

const JIRA_ALLOWED_ASSIGNEES = (process.env.JIRA_ALLOWED_ASSIGNEES || "")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);

const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

const auth = new google.auth.GoogleAuth({
  credentials: serviceAccount,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({
  version: "v4",
  auth,
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
    console.error("WEBHOOK ERROR:", err);
    res.status(500).end();
  }
});

async function handleEvent(event) {
  try {
    if (event.type !== "message" || event.message.type !== "text") return;

    console.log("SOURCE:", JSON.stringify(event.source));

    const userMessage = event.message.text;
    console.log("USER MESSAGE:", userMessage);

    if (!userMessage.startsWith("//")) {
      console.log("IGNORED: Not command");
      return;
    }

    const cleanMessage = userMessage.replace("//", "").trim();
    if (!cleanMessage) return;

    if (cleanMessage === "지라체크") {
      if (
        event.source.type !== "group" ||
        event.source.groupId !== ALERT_TARGET_ID
      ) {
        console.log("지라체크 허용되지 않은 방");
        return;
      }

      await checkNewJiras(true);
      await reply(event.replyToken, "JIRA 시트 수동 체크 완료");
      return;
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content:
            "너는 게임 운영자를 돕는 친절한 LINE 챗봇이다. 짧고 명확하게 한국어로 답변한다.",
        },
        {
          role: "user",
          content: cleanMessage,
        },
      ],
    });

    const replyText =
      completion.choices[0]?.message?.content || "답변을 생성하지 못했습니다.";

    console.log("GPT REPLY:", replyText);

    await reply(event.replyToken, replyText);
    console.log("REPLY SENT");
  } catch (err) {
    console.error("HANDLE EVENT ERROR:", err);
  }
}

async function reply(replyToken, text) {
  await client.replyMessage({
    replyToken,
    messages: [
      {
        type: "text",
        text: text.slice(0, 4900),
      },
    ],
  });
}

async function push(text) {
  if (!ALERT_TARGET_ID) {
    console.log("JIRA_ALERT_TARGET_ID 없음");
    return;
  }

  await client.pushMessage({
    to: ALERT_TARGET_ID,
    messages: [
      {
        type: "text",
        text: text.slice(0, 4900),
      },
    ],
  });
}

function colToIndex(col) {
  let index = 0;

  for (let i = 0; i < col.length; i++) {
    index = index * 26 + col.charCodeAt(i) - 64;
  }

  return index - 1;
}

async function ensureStateSheet() {
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId: SHEET_ID,
  });

  const exists = spreadsheet.data.sheets.some(
    (s) => s.properties.title === STATE_SHEET_NAME
  );

  if (exists) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [
        {
          addSheet: {
            properties: {
              title: STATE_SHEET_NAME,
            },
          },
        },
      ],
    },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${STATE_SHEET_NAME}!A1:B1`,
    valueInputOption: "RAW",
    requestBody: {
      values: [["JIRA_KEY", "DETECTED_AT"]],
    },
  });
}

async function getSeenJiraKeys() {
  await ensureStateSheet();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${STATE_SHEET_NAME}!A2:A`,
  });

  return new Set((res.data.values || []).flat().filter(Boolean));
}

async function saveSeenJiraKeys(keys) {
  if (!keys.length) return;

  const now = new Date().toISOString();

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${STATE_SHEET_NAME}!A:B`,
    valueInputOption: "RAW",
    requestBody: {
      values: keys.map((key) => [key, now]),
    },
  });
}

async function getJiraRows() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${JIRA_SHEET_NAME}!A:J`,
  });

  const rows = res.data.values || [];
  return rows.slice(1);
}

async function checkNewJiras(isManual = false) {
  try {
    console.log("JIRA CHECK START");

    const seenKeys = await getSeenJiraKeys();
    const rows = await getJiraRows();

    const keyIdx = colToIndex(JIRA_KEY_COLUMN);
    const titleIdx = colToIndex(JIRA_TITLE_COLUMN);
    const statusIdx = colToIndex(JIRA_STATUS_COLUMN);
    const linkIdx = colToIndex(JIRA_LINK_COLUMN);
    const typeIdx = colToIndex(JIRA_TYPE_COLUMN);
    const assigneeIdx = colToIndex(JIRA_ASSIGNEE_COLUMN);

    const newJiras = [];

    for (const row of rows) {
      const key = row[keyIdx]?.trim();
      if (!key) continue;

      const type = row[typeIdx]?.trim() || "-";
      const title = row[titleIdx]?.trim() || "-";
      const status = row[statusIdx]?.trim() || "-";
      const link = row[linkIdx]?.trim() || "-";
      const assignee = row[assigneeIdx]?.trim() || "-";

      if (
        JIRA_ALLOWED_ASSIGNEES.length > 0 &&
        !JIRA_ALLOWED_ASSIGNEES.includes(assignee)
      ) {
        continue;
      }

      if (!seenKeys.has(key)) {
        newJiras.push({
          key,
          type,
          title,
          status,
          assignee,
          link,
        });
      }
    }

    if (newJiras.length === 0) {
      console.log("신규 JIRA 없음");
      return;
    }

    await saveSeenJiraKeys(newJiras.map((j) => j.key));

    for (const jira of newJiras) {
      const message = `[신규 JIRA 감지]

유형:
${jira.type}

내용:
${jira.title}

담당자:
${jira.assignee}

상태:
${jira.status}

링크:
${jira.link}`;

      console.log(message);

      await push(message);
    }

    console.log(`신규 JIRA ${newJiras.length}건 알림 완료`);
  } catch (err) {
    console.error("JIRA CHECK ERROR:", err);
  }
}

cron.schedule("* * * * *", async () => {
  await checkNewJiras(false);
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
