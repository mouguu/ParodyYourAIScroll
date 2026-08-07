"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const conversationId = "12bc2b28-4d18-42ec-a8b2-8daa64f42bbd";
const windowListeners = new Map();
const sentRequests = [];

function addWindowListener(type, listener) {
  if (!windowListeners.has(type)) windowListeners.set(type, new Set());
  windowListeners.get(type).add(listener);
}

function dispatchWindowMessage(data, source) {
  for (const listener of windowListeners.get("message") || []) {
    listener({ source, data });
  }
}

class FakeXMLHttpRequest {
  constructor() {
    this.listeners = new Map();
    this.headers = [];
    this.status = 0;
    this.statusText = "";
    this.responseText = "";
    this.responseType = "";
    this.withCredentials = false;
    this.timeout = 0;
  }

  open(method, url) {
    this.method = method;
    this.url = String(url);
  }

  setRequestHeader(name, value) {
    this.headers.push([String(name), String(value)]);
  }

  addEventListener(type, listener, options = {}) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push({ listener, once: options.once === true });
  }

  emit(type) {
    const current = [...(this.listeners.get(type) || [])];
    this.listeners.set(
      type,
      current.filter((entry) => !entry.once)
    );
    current.forEach((entry) => entry.listener());
  }

  send(body) {
    sentRequests.push({
      method: this.method,
      url: this.url,
      headers: [...this.headers],
      withCredentials: this.withCredentials,
      body,
    });
    const url = new URL(this.url, "https://chat.qwen.ai");
    const cursor = url.searchParams.get("cursor");
    this.status = 200;
    this.statusText = "OK";
    if (url.pathname === "/api/v2/chats/") {
      this.responseText = JSON.stringify({
        success: true,
        data: [
          {
            id: conversationId,
            title: `List page ${url.searchParams.get("page") || "1"}`,
          },
        ],
      });
    } else {
      this.responseText = JSON.stringify({
        success: true,
        data: {
          id: conversationId,
          chat: {
            history: {
              messages: {},
              pagination: {
                enabled: true,
                oldest_id: cursor || "older-1",
                has_more_older: Boolean(!cursor),
              },
            },
          },
        },
      });
    }
    setTimeout(() => this.emit("load"), 0);
  }
}

const context = {
  console,
  setTimeout,
  clearTimeout,
  URL,
  location: {
    href: `https://chat.qwen.ai/c/${conversationId}`,
  },
  XMLHttpRequest: FakeXMLHttpRequest,
  addEventListener: addWindowListener,
  removeEventListener(type, listener) {
    windowListeners.get(type)?.delete(listener);
  },
};
context.window = context;
context.globalThis = context;

vm.createContext(context);
const windowProxy = vm.runInContext("window", context);
context.postMessage = (data) => dispatchWindowMessage(data, windowProxy);
vm.runInContext(
  fs.readFileSync(path.join(root, "qwen_api_bridge.js"), "utf8"),
  context,
  { filename: "qwen_api_bridge.js" }
);

const pageRequest = new context.XMLHttpRequest();
pageRequest.open(
  "GET",
  `/api/v2/chats/${conversationId}?direction=up&limit=10`,
  true
);
pageRequest.withCredentials = true;
pageRequest.setRequestHeader("version", "test-version");
pageRequest.send(null);

const pageListRequest = new context.XMLHttpRequest();
pageListRequest.open(
  "GET",
  "/api/v2/chats/?page=1&exclude_project=true",
  true
);
pageListRequest.withCredentials = true;
pageListRequest.setRequestHeader("version", "test-version");
pageListRequest.send(null);

function requestBridge(cursor = null) {
  return new Promise((resolve, reject) => {
    const requestId = `test-${cursor || "initial"}`;
    const timeoutId = setTimeout(
      () => reject(new Error(`Bridge request timed out: ${requestId}`)),
      1000
    );
    const listener = (event) => {
      if (
        event.data?.type !== "QWEN_CHAT_DATA_RESULT" ||
        event.data?.requestId !== requestId
      ) {
        return;
      }
      context.removeEventListener("message", listener);
      clearTimeout(timeoutId);
      if (!event.data.success) reject(new Error(event.data.error));
      else resolve(JSON.parse(event.data.responseText));
    };
    context.addEventListener("message", listener);
    context.postMessage({
      type: "QWEN_CHAT_DATA_REQUEST",
      requestId,
      chatId: conversationId,
      cursor,
      direction: "up",
      limit: 10,
    });
  });
}

function requestListBridge(page) {
  return new Promise((resolve, reject) => {
    const requestId = `list-${page}`;
    const timeoutId = setTimeout(
      () => reject(new Error(`List bridge request timed out: ${requestId}`)),
      1000
    );
    const listener = (event) => {
      if (
        event.data?.type !== "QWEN_CHAT_LIST_RESULT" ||
        event.data?.requestId !== requestId
      ) {
        return;
      }
      context.removeEventListener("message", listener);
      clearTimeout(timeoutId);
      if (!event.data.success) reject(new Error(event.data.error));
      else resolve(JSON.parse(event.data.responseText));
    };
    context.addEventListener("message", listener);
    context.postMessage({
      type: "QWEN_CHAT_LIST_REQUEST",
      requestId,
      page,
      exclude_project: true,
    });
  });
}

(async () => {
  await new Promise((resolve) => setTimeout(resolve, 10));
  const initial = await requestBridge();
  assert.equal(initial.success, true);
  const older = await requestBridge("older-1");
  assert.equal(older.data.chat.history.pagination.has_more_older, false);
  const listPage = await requestListBridge(2);
  assert.equal(listPage.data[0].title, "List page 2");
  assert.equal(sentRequests.length, 5);
  assert.match(sentRequests[2].url, /direction=up/);
  assert.match(sentRequests[3].url, /cursor=older-1/);
  assert.match(sentRequests[4].url, /page=2/);
  assert.match(sentRequests[4].url, /exclude_project=true/);
  assert.ok(
    sentRequests[4].headers.some(
      ([name, value]) => name === "version" && value === "test-version"
    )
  );
  assert.equal(sentRequests[4].withCredentials, true);
  console.log("Qwen API bridge simulation passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
