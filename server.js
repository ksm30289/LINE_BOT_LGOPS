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

const KNOWLEDGE_SHEET_NAME =
  process.env.KNOWLEDGE_SHEET_NAME || "BOT_KNOWLEDGE";

const UNDECEMBER_CS_GROUP_ID = process.env.UNDECEMBER_CS_GROUP_ID;
const FAIRYTAIL_CS_GROUP_ID = process.env.FAIRYTAIL_CS_GROUP_ID;

const UNDECEMBER_KNOWLEDGE_SHEET_ID =
  process.env.UNDECEMBER_KNOWLEDGE_SHEET_ID;
const FAIRYTAIL_KNOWLEDGE_SHEET_ID =
  process.env.FAIRYTAIL_KNOWLEDGE_SHEET_ID;

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

    const knowledgeSheetId = getKnowledgeSheetIdBySource(event.source);

    if (cleanMessage === "지라체크") {
      if (
        event.source.type !== "group" ||
        event.source.groupId !== ALERT_TARGET_ID
      ) {
        console.log("지라체크 허용되지 않은 방");
        return;
      }

      await checkNewJiras();
      await reply(event.replyToken, "JIRA 시트 수동 체크 완료");
      return;
    }

    if (
      cleanMessage.startsWith("학습 ") ||
      cleanMessage.startsWith("기억 ")
    ) {
      if (!knowledgeSheetId) {
        await reply(event.replyToken, "이 톡방은 학습 기능이 설정되지 않았어.");
        return;
      }

      const learningText = cleanMessage.replace(/^(학습|기억)\s+/, "").trim();

      let keyword;
      let answer;

      if (learningText.includes("|")) {
        const parts = learningText.split("|").map((v) => v.trim());
        keyword = parts[0];
        answer = parts.slice(1).join("|").trim();
      } else {
        answer = learningText;
        keyword = learningText
          .split(/\s+/)[0]
          .replace(/[은는이가을를,.!?]/g, "")
          .trim();
      }

      if (!keyword || !answer) {
        await reply(
          event.replyToken,
          "형식: //학습 키워드|답변 또는 //기억 답변내용"
        );
        return;
      }

      await saveKnowledge(knowledgeSheetId, keyword, answer);
      await reply(event.replyToken, `학습 완료: ${keyword}`);
      return;
    }

    if (knowledgeSheetId) {
      const learnedAnswer = await findKnowledge(knowledgeSheetId, cleanMessage);

      if (learnedAnswer) {
        await reply(event.replyToken, learnedAnswer);
        return;
      }
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

    await reply(event.replyToken, replyText);
    console.log("REPLY SENT");
  } catch (err) {
    console.error("HANDLE EVENT ERROR:", err);
  }
}

function getKnowledgeSheetIdBySource(source) {
  if (source.type !== "group") return null;

  if (source.groupId === UNDECEMBER_CS_GROUP_ID) {
    return UNDECEMBER_KNOWLEDGE_SHEET_ID;
  }

  if (source.groupId === FAIRYTAIL_CS_GROUP_ID) {
    return FAIRYTAIL_KNOWLEDGE_SHEET_ID;
  }

  return null;
}

async function reply(replyToken, text) {
  await client.replyMessage({
    replyToken,
    messages: [{ type: "text", text: text.slice(0, 4900) }],
  });
}

async function push(text) {
  if (!ALERT_TARGET_ID) {
    console.log("JIRA_ALERT_TARGET_ID 없음");
    return;
  }

  await client.pushMessage({
    to: ALERT_TARGET_ID,
    messages: [{ type: "text", text: text.slice(0, 4900) }],
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
      requests: [{ addSheet: { properties: { title: STATE_SHEET_NAME } } }],
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

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${STATE_SHEET_NAME}!A:B`,
    valueInputOption: "RAW",
    requestBody: {
      values: keys.map((key) => [key, new Date().toISOString()]),
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

async function checkNewJiras() {
  try {
    console.log("JIRA CHECK START");

    const seenKeys = await getSeenJiraKeys();
    const rows = await getJiraRows();

    const keyIdx = colToIndex(JIRA_KEY_COLUMN);
    const titleIdx = colToIndex(JIRA_TITLE_COLUMN);
    const linkIdx = colToIndex(JIRA_LINK_COLUMN);
    const assigneeIdx = colToIndex(JIRA_ASSIGNEE_COLUMN);

    const newJiras = [];

    for (const row of rows) {
      const key = row[keyIdx]?.trim();
      if (!key) continue;

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
          title: row[titleIdx]?.trim() || "-",
          link: row[linkIdx]?.trim() || "-",
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

내용:
${jira.title}

링크:
${jira.link}`;

      await push(message);
    }

    console.log(`신규 JIRA ${newJiras.length}건 알림 완료`);
  } catch (err) {
    console.error("JIRA CHECK ERROR:", err);
  }
}

async function ensureKnowledgeSheet(spreadsheetId) {
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });

  const exists = spreadsheet.data.sheets.some(
    (s) => s.properties.title === KNOWLEDGE_SHEET_NAME
  );

  if (exists) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        { addSheet: { properties: { title: KNOWLEDGE_SHEET_NAME } } },
      ],
    },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${KNOWLEDGE_SHEET_NAME}!A1:C1`,
    valueInputOption: "RAW",
    requestBody: {
      values: [["KEYWORD", "ANSWER", "CREATED_AT"]],
    },
  });
}

async function saveKnowledge(spreadsheetId, keyword, answer) {
  await ensureKnowledgeSheet(spreadsheetId);

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${KNOWLEDGE_SHEET_NAME}!A:C`,
    valueInputOption: "RAW",
    requestBody: {
      values: [[keyword, answer, new Date().toISOString()]],
    },
  });
}

async function findKnowledge(spreadsheetId, query) {
  await ensureKnowledgeSheet(spreadsheetId);

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${KNOWLEDGE_SHEET_NAME}!A2:B`,
  });

  const rows = res.data.values || [];
  const normalizedQuery = query.toLowerCase();

  for (const row of rows) {
    const keyword = row[0]?.trim();
    const answer = row[1]?.trim();

    if (!keyword || !answer) continue;

    const normalizedKeyword = keyword.toLowerCase();

    if (
      normalizedQuery.includes(normalizedKeyword) ||
      normalizedKeyword.includes(normalizedQuery)
    ) {
      return answer;
    }
  }

  return null;
}

cron.schedule("* * * * *", async () => {
  await checkNewJiras();
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
