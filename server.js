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
const JIRA_LINK_COLUMN = process.env.JIRA_LINK_COLUMN || "H";
const JIRA_ASSIGNEE_COLUMN = process.env.JIRA_ASSIGNEE_COLUMN || "I";

const JIRA_ALLOWED_ASSIGNEES = (process.env.JIRA_ALLOWED_ASSIGNEES || "")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);

const KNOWLEDGE_SHEET_NAME =
  process.env.KNOWLEDGE_SHEET_NAME || "BOT_KNOWLEDGE";

const REMINDER_SHEET_NAME =
  process.env.REMINDER_SHEET_NAME || "BOT_REMINDER";

// 언디셈버 CS
const UNDECEMBER_CS_GROUP_ID = process.env.UNDECEMBER_CS_GROUP_ID;
const UNDECEMBER_KNOWLEDGE_SHEET_ID =
  process.env.UNDECEMBER_KNOWLEDGE_SHEET_ID;

// 페어리테일 CS
const FAIRYTAIL_CS_GROUP_ID = process.env.FAIRYTAIL_CS_GROUP_ID;
const FAIRYTAIL_KNOWLEDGE_SHEET_ID =
  process.env.FAIRYTAIL_KNOWLEDGE_SHEET_ID;

// 언디셈버 QA
const UNDECEMBER_QA_GROUP_ID = process.env.UNDECEMBER_QA_GROUP_ID;
const UNDECEMBER_QA_KNOWLEDGE_SHEET_ID =
  process.env.UNDECEMBER_QA_KNOWLEDGE_SHEET_ID;

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

    const cleanMessage = userMessage.replace(/^\/\//, "").trim();
    if (!cleanMessage) return;

    const spreadsheetId = getKnowledgeSheetIdBySource(event.source);

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

    const reminderData = parseReminderCommand(cleanMessage);

    if (reminderData) {
      if (!spreadsheetId) {
        await reply(event.replyToken, "이 톡방은 리마인드 기능이 설정되지 않았어.");
        return;
      }

      if (event.source.type !== "group" || !event.source.groupId) {
        await reply(event.replyToken, "리마인드는 그룹 톡방에서만 등록할 수 있어.");
        return;
      }

      if (!event.source.userId) {
        await reply(event.replyToken, "요청자 정보를 확인할 수 없어 리마인드를 등록하지 못했어.");
        return;
      }

      await saveReminder({
        spreadsheetId,
        groupId: event.source.groupId,
        userId: event.source.userId,
        remindAt: reminderData.remindAt,
        message: reminderData.message,
      });

      await reply(
        event.replyToken,
        `[리마인드 등록 완료]\n${formatKst(reminderData.remindAt)}\n${reminderData.message}`
      );

      return;
    }

    if (cleanMessage.startsWith("학습 ") || cleanMessage.startsWith("기억 ")) {
      if (!spreadsheetId) {
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
        await reply(event.replyToken, "형식: //학습 키워드|답변");
        return;
      }

      await saveKnowledge(spreadsheetId, keyword, answer);
      await reply(event.replyToken, `학습 완료: ${keyword}`);
      return;
    }

    let knowledgeContext = "";

    if (spreadsheetId) {
      knowledgeContext = await getKnowledgeContext(spreadsheetId, cleanMessage);
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content:
            "너는 게임 운영자를 돕는 친절한 LINE 챗봇이다. 반드시 제공된 기억 내용을 우선 참고해서 답변한다. 기억에 없는 내용은 추측하지 말고 모른다고 답한다. 짧고 명확하게 한국어로 답변한다.",
        },
        {
          role: "user",
          content:
            `저장된 기억:\n${knowledgeContext || "없음"}\n\n` +
            `사용자 질문:\n${cleanMessage}`,
        },
      ],
    });

    const replyText = completion.choices[0]?.message?.content || "답변 생성 실패";

    console.log("GPT REPLY:", replyText);

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

  if (source.groupId === UNDECEMBER_QA_GROUP_ID) {
    return UNDECEMBER_QA_KNOWLEDGE_SHEET_ID;
  }

  return null;
}

function getAllReminderSpreadsheetIds() {
  return [
    UNDECEMBER_KNOWLEDGE_SHEET_ID,
    FAIRYTAIL_KNOWLEDGE_SHEET_ID,
    UNDECEMBER_QA_KNOWLEDGE_SHEET_ID,
  ].filter(Boolean);
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

async function pushReminder(groupId, userId, message) {
  const fallbackText = `@${userId}\n[리마인드]\n${message}`;

  try {
    await client.pushMessage({
      to: groupId,
      messages: [
        {
          type: "textV2",
          text: "{user}\n[리마인드]\n" + message,
          substitution: {
            user: {
              type: "mention",
              mentionee: {
                type: "user",
                userId,
              },
            },
          },
        },
      ],
    });
  } catch (err) {
    console.error("MENTION PUSH ERROR:", err);

    await client.pushMessage({
      to: groupId,
      messages: [
        {
          type: "text",
          text: fallbackText.slice(0, 4900),
        },
      ],
    });
  }
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
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId,
  });

  const exists = spreadsheet.data.sheets.some(
    (s) => s.properties.title === KNOWLEDGE_SHEET_NAME
  );

  if (exists) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          addSheet: {
            properties: {
              title: KNOWLEDGE_SHEET_NAME,
            },
          },
        },
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

function normalizeText(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[?!.。,，~]/g, "")
    .replace(/(은|는|이|가|을|를|에|의|도|만|님)$/g, "")
    .trim();
}

async function getKnowledgeContext(spreadsheetId, query) {
  await ensureKnowledgeSheet(spreadsheetId);

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${KNOWLEDGE_SHEET_NAME}!A2:B`,
  });

  const rows = res.data.values || [];
  if (rows.length === 0) return "";

  const normalizedQuery = normalizeText(query);

  const queryWords = normalizedQuery
    .split(/\s+/)
    .map((v) => normalizeText(v))
    .filter(Boolean);

  const scored = rows
    .map((row) => {
      const keyword = row[0]?.trim() || "";
      const answer = row[1]?.trim() || "";

      if (!keyword || !answer) return null;

      const text = normalizeText(`${keyword} ${answer}`);

      let score = 0;

      if (text.includes(normalizedQuery)) score += 10;

      if (normalizedQuery.includes(normalizeText(keyword))) score += 5;

      for (const word of queryWords) {
        if (text.includes(word)) score += 1;
      }

      return {
        keyword,
        answer,
        score,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return scored
    .filter((item) => item.score > 0)
    .map((item) => `- ${item.keyword}: ${item.answer}`)
    .join("\n");
}

function getKstNow() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
}

function toKstDate(year, month, day, hour, minute) {
  return new Date(
    Date.UTC(year, month - 1, day, hour - 9, minute, 0)
  );
}

function formatKst(date) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function parseReminderCommand(cleanMessage) {
  let text = cleanMessage.trim();

  if (text.startsWith("리마인드 ")) {
    text = text.replace(/^리마인드\s+/, "").trim();
  }

  const dateRegex =
    /(?:(\d{4})년\s*)?(\d{1,2})월\s*(\d{1,2})일\s*(\d{1,2})(?::|시)\s*(\d{1,2})?/;

  const match = text.match(dateRegex);

  if (!match) return null;

  const nowKst = getKstNow();

  let year = match[1] ? Number(match[1]) : nowKst.getFullYear();
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = match[5] ? Number(match[5]) : 0;

  let message = "";

  if (text.includes("|")) {
    message = text.split("|").slice(1).join("|").trim();
  } else {
    message = text.slice(match.index + match[0].length).trim();

    message = message
      .replace(/^에\s*/, "")
      .replace(/^나한테\s*/, "")
      .replace(/(하라고\s*)?(리마인드\s*해줘|알려줘|알림\s*해줘)\s*$/g, "")
      .trim();
  }

  if (!message) return null;

  let remindAt = toKstDate(year, month, day, hour, minute);

  if (!match[1] && remindAt.getTime() < Date.now()) {
    year += 1;
    remindAt = toKstDate(year, month, day, hour, minute);
  }

  return {
    remindAt,
    message,
  };
}

async function ensureReminderSheet(spreadsheetId) {
  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId,
  });

  const exists = spreadsheet.data.sheets.some(
    (s) => s.properties.title === REMINDER_SHEET_NAME
  );

  if (exists) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          addSheet: {
            properties: {
              title: REMINDER_SHEET_NAME,
            },
          },
        },
      ],
    },
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${REMINDER_SHEET_NAME}!A1:G1`,
    valueInputOption: "RAW",
    requestBody: {
      values: [
        [
          "ID",
          "GROUP_ID",
          "USER_ID",
          "REMIND_AT",
          "MESSAGE",
          "DONE",
          "CREATED_AT",
        ],
      ],
    },
  });
}

async function saveReminder({ spreadsheetId, groupId, userId, remindAt, message }) {
  await ensureReminderSheet(spreadsheetId);

  const id = `R-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${REMINDER_SHEET_NAME}!A:G`,
    valueInputOption: "RAW",
    requestBody: {
      values: [
        [
          id,
          groupId,
          userId,
          remindAt.toISOString(),
          message,
          "N",
          new Date().toISOString(),
        ],
      ],
    },
  });
}

async function checkDueReminders() {
  try {
    const spreadsheetIds = getAllReminderSpreadsheetIds();

    for (const spreadsheetId of spreadsheetIds) {
      await ensureReminderSheet(spreadsheetId);

      const res = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${REMINDER_SHEET_NAME}!A2:G`,
      });

      const rows = res.data.values || [];
      const now = Date.now();

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];

        const groupId = row[1];
        const userId = row[2];
        const remindAtText = row[3];
        const message = row[4];
        const done = row[5];

        if (done === "Y") continue;
        if (!groupId || !userId || !remindAtText || !message) continue;

        const remindAt = new Date(remindAtText);

        if (remindAt.getTime() > now) continue;

        await pushReminder(groupId, userId, message);

        const rowNumber = i + 2;

        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `${REMINDER_SHEET_NAME}!F${rowNumber}`,
          valueInputOption: "RAW",
          requestBody: {
            values: [["Y"]],
          },
        });

        console.log(`REMINDER SENT: ${message}`);
      }
    }
  } catch (err) {
    console.error("REMINDER CHECK ERROR:", err);
  }
}

cron.schedule("* * * * *", async () => {
  await checkNewJiras();
  await checkDueReminders();
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
