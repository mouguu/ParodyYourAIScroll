"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

const exporter = require(path.join(__dirname, "..", "qwen_exporter.js"));

const conversationId = "12bc2b28-4d18-42ec-a8b2-8daa64f42bbd";
const fileUrl = "https://cdn.qwenlm.ai/example/upload.png";

function user(id, parentId, content, files = []) {
  return {
    id,
    parentId,
    childrenIds: [],
    role: "user",
    content,
    files,
    timestamp: 1786093900,
  };
}

function assistant(id, parentId, answer, options = {}) {
  return {
    id,
    parentId,
    childrenIds: [],
    role: "assistant",
    content: "",
    model: "qwen3-test",
    modelName: "Qwen Test",
    timestamp: 1786093901,
    content_list: [
      ...(options.thinking
        ? [
            {
              phase: "thinking_summary",
              role: "assistant",
              status: "finished",
              content: "",
              extra: {
                summary_title: { content: "Plan" },
                summary_thought: { content: options.thinking },
              },
            },
          ]
        : []),
      ...(options.source
        ? [
            {
              phase: "web_search",
              role: "function",
              status: "finished",
              content: "",
              extra: {
                web_search_info: [options.source],
                tool_result: { docs: [options.source] },
              },
            },
          ]
        : []),
      {
        phase: "answer",
        role: "assistant",
        status: "finished",
        content: answer,
        extra: {},
      },
    ],
  };
}

const source = {
  title: "Primary source",
  url: "https://example.test/source",
  snippet: "A source-backed summary.",
};
const u1 = user("u1", null, "First question", [
  {
    id: "file-1",
    name: "upload.png",
    url: fileUrl,
    file_type: "image",
    size: 1234,
  },
]);
const oldAnswer = assistant("a-old", "u1", "Old regenerated answer");
const a1 = assistant("a1", "u1", "Current answer [1]", {
  thinking: "Checked the source before answering.",
  source,
});
const u2 = user("u2", "a1", "Follow-up question");
const a2 = assistant("a2", "u2", "Follow-up answer");

u1.childrenIds = ["a-old", "a1"];
a1.childrenIds = ["u2"];
u2.childrenIds = ["a2"];

const payload = {
  success: true,
  data: {
    id: conversationId,
    title: "Qwen exporter test",
    created_at: 1786093900,
    updated_at: 1786094000,
    currentId: "a2",
    currentResponseIds: ["a2"],
    chat: {
      messages: [u1, a1, u2, a2],
      history: {
        currentId: "a2",
        currentResponseIds: ["a2"],
        messages: { u1, "a-old": oldAnswer, a1, u2, a2 },
      },
    },
  },
};

assert.equal(exporter.getConversationId(`/c/${conversationId}`), conversationId);
assert.equal(exporter.getConversationId("/c/new"), null);

const result = exporter.processConversation(payload);
assert.deepEqual(
  result.messages.map((message) => message.responseId),
  ["u1", "a1", "u2", "a2"]
);
assert.equal(result.meta.platform, "QWEN");
assert.equal(result.meta.extractionMode, "qwen_api");
assert.equal(result.meta.conversationUuid, conversationId);
assert.equal(result.meta.conversationTitle, "Qwen exporter test");
assert.equal(result.meta.currentLeafMessageUuid, "a2");
assert.equal(result.meta.totalConversationMessageCount, 5);
assert.equal(result.meta.exportedMessageCount, 4);
assert.equal(result.meta.userMessageCount, 2);
assert.equal(result.meta.assistantMessageCount, 2);
assert.equal(result.meta.thinkingMessageCount, 1);
assert.equal(result.meta.attachmentCount, 1);
assert.equal(result.meta.citationCount, 1);
assert.equal(result.meta.branchCount, 2);
assert.equal(result.meta.model, "Qwen Test");

assert.match(result.messages[0].userText, /upload\.png/);
assert.equal(result.messages[0].attachments[0].url, fileUrl);
assert.match(result.messages[1].thoughtText, /Checked the source/);
assert.match(result.messages[1].responseText, /Current answer \[1\]/);
assert.match(result.messages[1].responseText, /### Sources/);
assert.equal(result.messages[1].citations.length, 1);

const olderPage = {
  success: true,
  data: {
    id: conversationId,
    chat: {
      history: {
        messages: { u1, a1 },
        pagination: {
          enabled: true,
          oldest_id: "u1",
          has_more_older: false,
        },
      },
    },
  },
};
const newestPage = {
  success: true,
  data: {
    id: conversationId,
    title: "Paginated Qwen test",
    currentId: "a2",
    chat: {
      history: {
        currentId: "a2",
        messages: { u2, a2 },
        pagination: {
          enabled: true,
          oldest_id: "u2",
          has_more_older: true,
        },
      },
    },
  },
};

exporter.mergeConversationPayload(newestPage, olderPage);
const paginated = exporter.processConversation(newestPage, {
  extractionMode: "qwen_api_bridge",
});
assert.deepEqual(
  paginated.messages.map((message) => message.responseId),
  ["u1", "a1", "u2", "a2"]
);
assert.equal(paginated.meta.extractionMode, "qwen_api_bridge");
assert.equal(exporter.getPagination(newestPage).has_more_older, false);

const empty = exporter.normalizeMessage(
  assistant("empty", "u2", ""),
  0
);
assert.equal(empty.emptyResponse, true);
assert.equal(empty.responseText, "[Empty Qwen response]");

console.log("Qwen exporter parser simulation passed");
