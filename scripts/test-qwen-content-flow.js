"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const conversationId = "12bc2b28-4d18-42ec-a8b2-8daa64f42bbd";
const secondConversationId = "32189daa-ed43-24bb-c81a-d2bb24cb21a9";
const runtimeMessages = [];
let contentMessageListener = null;
let historyRequestCount = 0;
let listRequestCount = 0;
let historyFetchOptions = null;

class FakeZip {
  static last = null;

  constructor() {
    this.files = new Map();
    FakeZip.last = this;
  }

  file(name, content) {
    this.files.set(name, content);
    return this;
  }

  async generateAsync(_options, onProgress) {
    onProgress?.({ percent: 100 });
    return new Blob(["fake-qwen-batch-zip"], { type: "application/zip" });
  }
}

class FakeFileReader {
  readAsDataURL() {
    this.result = "data:application/zip;base64,ZmFrZQ==";
    setTimeout(() => this.onload?.(), 0);
  }
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "manifest.json"), "utf8")
);
assert.ok(manifest.host_permissions.includes("https://chat.qwen.ai/*"));
assert.ok(manifest.host_permissions.includes("https://cdn.qwenlm.ai/*"));
const sharedContentScript = manifest.content_scripts.find((entry) =>
  entry.matches.includes("https://chat.qwen.ai/*")
);
assert.ok(sharedContentScript);
assert.ok(sharedContentScript.js.includes("qwen_exporter.js"));
assert.ok(
  sharedContentScript.js.indexOf("qwen_exporter.js") <
    sharedContentScript.js.indexOf("content.js")
);
const qwenBridgeScript = manifest.content_scripts.find(
  (entry) =>
    entry.world === "MAIN" &&
    entry.matches.includes("https://chat.qwen.ai/*")
);
assert.ok(qwenBridgeScript?.js.includes("qwen_api_bridge.js"));
assert.match(
  fs.readFileSync(path.join(root, "background.js"), "utf8"),
  /isQwen/
);
assert.match(
  fs.readFileSync(path.join(root, "supported.js"), "utf8"),
  /Qwen - Conversation/
);
assert.match(
  fs.readFileSync(path.join(root, "supported.js"), "utf8"),
  /QWEN RECENTS/
);

const u1 = {
  id: "u1",
  parentId: null,
  childrenIds: ["a1"],
  role: "user",
  content: "Hello Qwen",
  files: [
    {
      id: "image-1",
      name: "reference.png",
      url: "https://cdn.qwenlm.ai/example/reference.png",
      file_type: "image",
    },
  ],
  timestamp: 1786093900,
};
const a1 = {
  id: "a1",
  parentId: "u1",
  childrenIds: [],
  role: "assistant",
  content: "",
  modelName: "Qwen Integration",
  timestamp: 1786093901,
  content_list: [
    {
      phase: "thinking_summary",
      role: "assistant",
      status: "finished",
      content: "",
      extra: {
        summary_title: { content: "Review" },
        summary_thought: { content: "Checked the supplied image." },
      },
    },
    {
      phase: "web_search",
      role: "function",
      status: "finished",
      content: "",
      extra: {
        web_search_info: [
          {
            title: "Qwen source",
            url: "https://example.test/qwen-source",
            snippet: "Supporting evidence.",
          },
        ],
      },
    },
    {
      phase: "answer",
      role: "assistant",
      status: "finished",
      content: "Hello from Qwen [1]",
      extra: {},
    },
  ],
};
const apiPayload = {
  success: true,
  data: {
    id: conversationId,
    title: "Qwen integration export",
    created_at: 1786093900,
    updated_at: 1786093901,
    currentId: "a1",
    chat: {
      messages: [u1, a1],
      history: {
        currentId: "a1",
        currentResponseIds: ["a1"],
        messages: { u1, a1 },
      },
    },
  },
};

const documentStub = {
  title: "Qwen integration export | Qwen",
  body: {},
  documentElement: {},
  cookie: "",
  querySelector() {
    return null;
  },
  querySelectorAll() {
    return [];
  },
  createElement() {
    return {
      style: {},
      classList: { add() {}, remove() {}, contains() { return false; } },
      appendChild() {},
      remove() {},
      click() {},
      setAttribute() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
      textContent: "",
      innerHTML: "",
    };
  },
};

const context = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  AbortController,
  Blob,
  URL,
  URLSearchParams,
  TextEncoder,
  TextDecoder,
  JSZip: FakeZip,
  FileReader: FakeFileReader,
  document: documentStub,
  location: {
    href: `https://chat.qwen.ai/c/${conversationId}`,
    pathname: `/c/${conversationId}`,
  },
  navigator: { userAgent: "Node test" },
  addEventListener() {},
  removeEventListener() {},
  postMessage() {},
  chrome: {
    runtime: {
      sendMessage(message, callback) {
        runtimeMessages.push(message);
        callback?.({ success: true });
      },
      onMessage: {
        addListener(listener) {
          contentMessageListener = listener;
        },
      },
    },
  },
  fetch: async (url, options = {}) => {
    const requestUrl = String(url);
    if (requestUrl.startsWith("/api/v2/chats/?")) {
      const parsed = new URL(requestUrl, "https://chat.qwen.ai");
      assert.equal(parsed.searchParams.get("page"), "1");
      assert.equal(parsed.searchParams.get("exclude_project"), "true");
      listRequestCount += 1;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        async json() {
          return {
            success: true,
            data: [
              {
                id: conversationId,
                title: "Qwen integration export",
                created_at: 1786093900,
                updated_at: 1786093901,
              },
              {
                id: secondConversationId,
                title: "Second Qwen export",
                created_at: 1786093902,
                updated_at: 1786093903,
              },
            ],
          };
        },
      };
    }

    const chatId = requestUrl.match(
      /^\/api\/v2\/chats\/([0-9a-f-]+)\?direction=up&limit=10$/i
    )?.[1];
    assert.ok(
      chatId === conversationId || chatId === secondConversationId,
      `Unexpected Qwen chat request: ${requestUrl}`
    );
    historyRequestCount += 1;
    historyFetchOptions = options;
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      async json() {
        const payload = JSON.parse(JSON.stringify(apiPayload));
        payload.data.id = chatId;
        payload.data.title =
          chatId === conversationId
            ? "Qwen integration export"
            : "Second Qwen export";
        return payload;
      },
    };
  },
};
context.window = context;
context.globalThis = context;

vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(root, "template.js"), "utf8"), context, {
  filename: "template.js",
});
vm.runInContext(
  fs.readFileSync(path.join(root, "qwen_exporter.js"), "utf8"),
  context,
  { filename: "qwen_exporter.js" }
);
vm.runInContext(fs.readFileSync(path.join(root, "content.js"), "utf8"), context, {
  filename: "content.js",
});

assert.equal(typeof contentMessageListener, "function");
const immediateResult = contentMessageListener(
  { action: "START_SCRAPE", format: "markdown", download: false },
  {},
  () => {}
);
assert.equal(immediateResult, false);

async function waitForCompletion() {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const complete = runtimeMessages.find(
      (message) => message.action === "SCRAPE_COMPLETE"
    );
    if (complete) return complete;
    const failure = runtimeMessages.find(
      (message) => message.action === "SCRAPE_ERROR"
    );
    if (failure) throw new Error(failure.error);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for Qwen content-script export");
}

waitForCompletion()
  .then(async (complete) => {
    assert.match(complete.data, /title: "Qwen integration export"/);
    assert.match(complete.data, /platform: "QWEN"/);
    assert.match(complete.data, /extraction_mode: "qwen_api"/);
    assert.match(complete.data, /attachment_count: 1/);
    assert.match(complete.data, /citation_count: 1/);
    assert.match(complete.data, /\*\*User\*\*:\nHello Qwen/);
    assert.match(complete.data, /reference\.png/);
    assert.match(complete.data, /> \*\*Thinking\*\*:\n> Review/);
    assert.match(complete.data, /Checked the supplied image/);
    assert.match(complete.data, /\*\*Model\*\*:\nHello from Qwen \[1\]/);
    assert.match(complete.data, /Qwen source/);
    assert.match(complete.filename, /^qwen\+/);
    assert.equal(historyRequestCount, 1);
    assert.equal(historyFetchOptions.credentials, "include");
    assert.equal(historyFetchOptions.cache, "no-store");

    runtimeMessages.length = 0;
    contentMessageListener(
      { action: "START_SCRAPE", format: "json", download: false },
      {},
      () => {}
    );
    const jsonComplete = await waitForCompletion();
    const jsonExport = JSON.parse(jsonComplete.data);
    assert.equal(jsonExport.meta.platform, "QWEN");
    assert.equal(jsonExport.meta.extractionMode, "qwen_api");
    assert.equal(jsonExport.meta.attachmentCount, 1);
    assert.equal(jsonExport.meta.citationCount, 1);
    assert.equal(jsonExport.messages.length, 2);
    assert.equal(jsonExport.messages[0].attachments.length, 1);
    assert.equal(historyRequestCount, 2);

    runtimeMessages.length = 0;
    contentMessageListener(
      {
        action: "START_PLATFORM_BATCH_EXPORT",
        format: "markdown",
        limit: 2,
        download: true,
      },
      {},
      () => {}
    );
    const batchComplete = await waitForCompletion();
    assert.equal(batchComplete.format, "zip");
    assert.equal(batchComplete.directDownload, true);
    assert.match(batchComplete.filename, /^qwen\+/);
    assert.equal(listRequestCount, 1);
    assert.equal(historyRequestCount, 4);
    assert.ok(FakeZip.last);
    assert.equal(FakeZip.last.files.size, 3);
    assert.equal(
      [...FakeZip.last.files.keys()].filter((name) => name.endsWith(".md"))
        .length,
      2
    );
    const batchManifest = JSON.parse(FakeZip.last.files.get("_manifest.json"));
    assert.equal(batchManifest.source, "Qwen");
    assert.equal(batchManifest.exported_count, 2);
    assert.equal(batchManifest.failed_count, 0);
    assert.equal(batchManifest.conversations.length, 2);
    console.log("Qwen content-script integration simulation passed");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
