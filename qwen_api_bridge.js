/**
 * Qwen conversation-response bridge.
 *
 * Qwen loads conversation history through page-owned Axios/XHR requests. Its
 * security layer may add transient request headers that an isolated extension
 * content script cannot reproduce. This MAIN-world bridge captures only the
 * read-only conversation response and a replay template. Cookies and request
 * headers never leave the page world.
 */
(function () {
  "use strict";

  if (window.__PARODY_QWEN_API_BRIDGE_INSTALLED__) return;
  Object.defineProperty(window, "__PARODY_QWEN_API_BRIDGE_INSTALLED__", {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });

  const REQUEST_TYPE = "QWEN_CHAT_DATA_REQUEST";
  const RESPONSE_TYPE = "QWEN_CHAT_DATA_RESULT";
  const LIST_REQUEST_TYPE = "QWEN_CHAT_LIST_REQUEST";
  const LIST_RESPONSE_TYPE = "QWEN_CHAT_LIST_RESULT";
  const MAX_CAPTURED_RESPONSES = 8;
  const MAX_RESPONSE_AGE_MS = 60 * 60 * 1000;
  const REPLAY_TIMEOUT_MS = 12000;
  const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const capturedResponses = [];

  function getConversationRequestInfo(value) {
    try {
      const url = new URL(String(value || ""), location.href);
      if (url.hostname !== "chat.qwen.ai") return null;
      if (url.pathname === "/api/v2/chats/") {
        return { kind: "list", chatId: null, url };
      }
      const match = url.pathname.match(/^\/api\/v2\/chats\/([0-9a-f-]{36})$/i);
      if (!match || !UUID_PATTERN.test(match[1])) return null;
      return { kind: "conversation", chatId: match[1].toLowerCase(), url };
    } catch {
      return null;
    }
  }

  function normalizeResponseText(xhr) {
    try {
      if (xhr.responseType === "json") {
        return JSON.stringify(xhr.response);
      }
      return String(xhr.responseText || "");
    } catch {
      try {
        return typeof xhr.response === "string"
          ? xhr.response
          : JSON.stringify(xhr.response);
      } catch {
        return "";
      }
    }
  }

  function recordResponse(info, responseText, requestTemplate) {
    if (!info || !responseText) return;
    const entry = {
      chatId: info.chatId,
      kind: info.kind,
      url: info.url.href,
      responseText,
      capturedAt: Date.now(),
      requestTemplate,
    };
    capturedResponses.unshift(entry);
    capturedResponses.splice(MAX_CAPTURED_RESPONSES);
    console.debug(
      `[Qwen API Bridge] Captured ${info.chatId || "chat-list"} (${responseText.length} chars)`
    );
  }

  function patchXmlHttpRequest() {
    const Xhr = window.XMLHttpRequest;
    if (!Xhr?.prototype) return;

    const originalOpen = Xhr.prototype.open;
    const originalSend = Xhr.prototype.send;
    const originalSetRequestHeader = Xhr.prototype.setRequestHeader;

    Xhr.prototype.open = function (method, url, ...rest) {
      const info = getConversationRequestInfo(url);
      this.__parodyQwenRequestInfo = info;
      this.__parodyQwenRequestTemplate = info
        ? {
            method: String(method || "GET").toUpperCase(),
            url: info.url.href,
            headers: [],
            body: null,
            withCredentials: false,
          }
        : null;
      return originalOpen.call(this, method, url, ...rest);
    };

    if (typeof originalSetRequestHeader === "function") {
      Xhr.prototype.setRequestHeader = function (name, value) {
        if (this.__parodyQwenRequestTemplate) {
          this.__parodyQwenRequestTemplate.headers.push([
            String(name),
            String(value),
          ]);
        }
        return originalSetRequestHeader.call(this, name, value);
      };
    }

    Xhr.prototype.send = function (...args) {
      const info = this.__parodyQwenRequestInfo;
      const template = this.__parodyQwenRequestTemplate;
      if (template) {
        template.body = args[0] ?? null;
        template.withCredentials = Boolean(this.withCredentials);
      }

      if (!this.__parodyQwenSkipCapture && info && template?.method === "GET") {
        this.addEventListener(
          "load",
          () => {
            if (this.status < 200 || this.status >= 300) return;
            recordResponse(info, normalizeResponseText(this), template);
          },
          { once: true }
        );
      }
      return originalSend.apply(this, args);
    };
  }

  function findCapturedResponse(chatId, cursor) {
    const now = Date.now();
    return (
      capturedResponses.find((entry) => {
        if (
          entry.kind !== "conversation" ||
          entry.chatId !== chatId ||
          now - entry.capturedAt > MAX_RESPONSE_AGE_MS
        ) {
          return false;
        }
        const entryCursor = new URL(entry.url).searchParams.get("cursor") || "";
        return entryCursor === String(cursor || "");
      }) ||
      capturedResponses.find(
        (entry) =>
          entry.kind === "conversation" &&
          entry.chatId === chatId &&
          now - entry.capturedAt <= MAX_RESPONSE_AGE_MS
      ) ||
      capturedResponses.find(
        (entry) =>
          entry.kind === "conversation" &&
          now - entry.capturedAt <= MAX_RESPONSE_AGE_MS
      ) ||
      null
    );
  }

  function findCapturedListResponse(page) {
    const now = Date.now();
    const normalizedPage = String(page || 1);
    return (
      capturedResponses.find(
        (entry) =>
          entry.kind === "list" &&
          now - entry.capturedAt <= MAX_RESPONSE_AGE_MS &&
          (new URL(entry.url).searchParams.get("page") || "1") === normalizedPage
      ) ||
      capturedResponses.find(
        (entry) =>
          entry.kind === "list" &&
          now - entry.capturedAt <= MAX_RESPONSE_AGE_MS
      ) ||
      null
    );
  }

  function buildReplayUrl(entry, request) {
    const url = new URL(entry.requestTemplate?.url || entry.url, location.href);
    if (UUID_PATTERN.test(String(request.chatId || ""))) {
      url.pathname = `/api/v2/chats/${String(request.chatId).toLowerCase()}`;
    }
    for (const key of [
      "cursor",
      "direction",
      "limit",
      "page",
      "exclude_project",
    ]) {
      const value = request[key];
      if (value === undefined || value === null || value === "") {
        if (key === "cursor") url.searchParams.delete(key);
        continue;
      }
      url.searchParams.set(key, String(value));
    }
    return url.href;
  }

  function replayCapturedRequest(entry, request) {
    return new Promise((resolve, reject) => {
      const template = entry?.requestTemplate;
      if (!template) {
        reject(new Error("No replayable Qwen request is available."));
        return;
      }

      const xhr = new window.XMLHttpRequest();
      xhr.__parodyQwenSkipCapture = true;
      xhr.open(template.method || "GET", buildReplayUrl(entry, request), true);
      xhr.withCredentials = Boolean(template.withCredentials);
      xhr.timeout = REPLAY_TIMEOUT_MS;

      for (const [name, value] of template.headers || []) {
        try {
          xhr.setRequestHeader(name, value);
        } catch (error) {
          console.debug(
            `[Qwen API Bridge] Could not replay header ${name}:`,
            error
          );
        }
      }

      xhr.addEventListener(
        "load",
        () => {
          const responseText = normalizeResponseText(xhr);
          if (xhr.status < 200 || xhr.status >= 300) {
            reject(new Error(`Qwen replay returned HTTP ${xhr.status}.`));
            return;
          }
          const info = getConversationRequestInfo(buildReplayUrl(entry, request));
          recordResponse(info, responseText, {
            ...template,
            url: buildReplayUrl(entry, request),
          });
          resolve(responseText);
        },
        { once: true }
      );
      xhr.addEventListener(
        "error",
        () => reject(new Error("Qwen XHR replay failed.")),
        { once: true }
      );
      xhr.addEventListener(
        "timeout",
        () => reject(new Error("Qwen XHR replay timed out.")),
        { once: true }
      );
      xhr.send(template.body ?? null);
    });
  }

  window.addEventListener("message", (event) => {
    if (
      event.source !== window ||
      ![REQUEST_TYPE, LIST_REQUEST_TYPE].includes(event.data?.type)
    ) {
      return;
    }
    const request = event.data;
    const isListRequest = request.type === LIST_REQUEST_TYPE;
    const chatId = String(request.chatId || "").toLowerCase();
    if (!isListRequest && !UUID_PATTERN.test(chatId)) return;

    const entry = isListRequest
      ? findCapturedListResponse(request.page)
      : findCapturedResponse(chatId, request.cursor);
    const responseType = isListRequest ? LIST_RESPONSE_TYPE : RESPONSE_TYPE;
    if (!entry) {
      window.postMessage(
        {
          type: responseType,
          requestId: request.requestId,
          chatId,
          success: false,
          error: isListRequest
            ? "No captured Qwen chat-list request is available. Refresh the page once."
            : "No captured Qwen conversation request is available. Refresh the page once.",
        },
        "*"
      );
      return;
    }

    replayCapturedRequest(entry, request)
      .catch((error) => {
        if ((!isListRequest && !request.cursor) || (isListRequest && Number(request.page || 1) === 1)) {
          return entry.responseText;
        }
        throw error;
      })
      .then((responseText) => {
        window.postMessage(
          {
            type: responseType,
            requestId: request.requestId,
            chatId,
            success: true,
            responseText,
          },
          "*"
        );
      })
      .catch((error) => {
        window.postMessage(
          {
            type: responseType,
            requestId: request.requestId,
            chatId,
            success: false,
            error: error?.message || "Qwen request replay failed.",
          },
          "*"
        );
      });
  });

  patchXmlHttpRequest();
})();
