/**
 * Google AI Studio RPC response bridge.
 *
 * Runs in the page's MAIN world before AI Studio starts. The page already
 * performs authenticated MakerSuite RPC calls to load Drive-backed prompts.
 * We keep a clone of the relevant response so the isolated content script can
 * export the complete prompt without scrolling through virtualized DOM nodes.
 *
 * No request headers, cookies, OAuth tokens, or request bodies leave the page.
 */
(function () {
  "use strict";

  if (window.__PARODY_AISTUDIO_RPC_BRIDGE_INSTALLED__) return;
  Object.defineProperty(window, "__PARODY_AISTUDIO_RPC_BRIDGE_INSTALLED__", {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });

  const REQUEST_TYPE = "AISTUDIO_RPC_DATA_REQUEST";
  const RESPONSE_TYPE = "AISTUDIO_RPC_DATA_RESULT";
  const DRIVE_FILES_REQUEST_TYPE = "AISTUDIO_DRIVE_FILES_REQUEST";
  const DRIVE_FILES_RESPONSE_TYPE = "AISTUDIO_DRIVE_FILES_RESULT";
  const MAX_CAPTURED_RESPONSES = 6;
  const MAX_RESPONSE_AGE_MS = 30 * 60 * 1000;
  const MAX_DRIVE_FILE_COUNT = 32;
  const MAX_DRIVE_TEXT_BYTES_PER_FILE = 4 * 1024 * 1024;
  const MAX_DRIVE_TEXT_BYTES_TOTAL = 12 * 1024 * 1024;
  const MAX_CONCURRENT_DRIVE_FILES = 5;
  const MAX_CACHED_DRIVE_FILES = 64;
  const MAX_CACHED_DRIVE_TEXT_BYTES = 16 * 1024 * 1024;
  const DRIVE_FILE_CACHE_TTL_MS = 10 * 60 * 1000;
  const DRIVE_METADATA_TIMEOUT_MS = 8000;
  const DRIVE_CONTENT_TIMEOUT_MS = 15000;
  const RPC_REPLAY_TIMEOUT_MS = 30000;
  const DRIVE_API_ORIGIN = "https://content.googleapis.com";
  const READ_ONLY_RPC_METHODS = new Set([
    "ResolveDriveResource",
    "GetPrompt",
  ]);
  const capturedResponses = [];
  const driveFileCache = new Map();
  let cachedDriveTextBytes = 0;
  let originalFetchImpl = null;

  function getRpcMethod(url) {
    const value = String(url || "");
    if (value.includes("MakerSuiteService/ResolveDriveResource")) {
      return "ResolveDriveResource";
    }
    if (value.includes("MakerSuiteService/GetPrompt")) {
      return "GetPrompt";
    }
    if (value.includes("MakerSuiteService/UpdatePrompt")) {
      return "UpdatePrompt";
    }
    if (value.includes("MakerSuiteService/CreatePrompt")) {
      return "CreatePrompt";
    }
    return null;
  }

  function normalizeResponseText(value) {
    if (typeof value === "string") return value;
    if (value === null || value === undefined) return "";
    try {
      return JSON.stringify(value);
    } catch {
      return "";
    }
  }

  function recordResponse(url, responseText, transport, replayRequest = null) {
    const method = getRpcMethod(url);
    const normalizedText = normalizeResponseText(responseText);
    if (!method || !normalizedText) return;

    const entry = {
      method,
      url: String(url),
      responseText: normalizedText,
      capturedAt: Date.now(),
      transport,
      replayRequest,
    };

    capturedResponses.unshift(entry);
    capturedResponses.splice(MAX_CAPTURED_RESPONSES);
    console.debug(
      `[AI Studio RPC Bridge] Captured ${method} (${normalizedText.length} chars)`
    );
  }

  function patchFetch() {
    if (typeof window.fetch !== "function") return;

    const originalFetch = window.fetch;
    originalFetchImpl = originalFetch.bind(window);
    window.fetch = async function (...args) {
      const input = args[0];
      const init = args[1];
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input?.url;
      const rpcMethod = getRpcMethod(url);
      let replayRequest = null;

      if (READ_ONLY_RPC_METHODS.has(rpcMethod)) {
        try {
          replayRequest = new Request(input, init).clone();
        } catch (error) {
          console.debug(
            "[AI Studio RPC Bridge] Could not retain read-only request:",
            error
          );
        }
      }

      const response = await originalFetch.apply(this, args);

      if (response?.ok && rpcMethod) {
        response
          .clone()
          .text()
          .then((text) => recordResponse(url, text, "fetch", replayRequest))
          .catch((error) =>
            console.debug("[AI Studio RPC Bridge] Fetch clone failed:", error)
          );
      }

      return response;
    };
  }

  function patchXmlHttpRequest() {
    const Xhr = window.XMLHttpRequest;
    if (!Xhr?.prototype) return;

    const originalOpen = Xhr.prototype.open;
    const originalSend = Xhr.prototype.send;
    const originalSetRequestHeader = Xhr.prototype.setRequestHeader;

    Xhr.prototype.open = function (method, url, ...rest) {
      this.__aistudioRpcUrl = String(url || "");
      this.__aistudioRpcRequestTemplate = {
        transport: "xhr",
        method: String(method || "GET").toUpperCase(),
        url: this.__aistudioRpcUrl,
        headers: [],
        body: null,
        withCredentials: false,
      };
      return originalOpen.call(this, method, url, ...rest);
    };

    if (typeof originalSetRequestHeader === "function") {
      Xhr.prototype.setRequestHeader = function (name, value) {
        const template = this.__aistudioRpcRequestTemplate;
        if (template) {
          template.headers.push([String(name), String(value)]);
        }
        return originalSetRequestHeader.call(this, name, value);
      };
    }

    Xhr.prototype.send = function (...args) {
      const rpcMethod = getRpcMethod(this.__aistudioRpcUrl);
      const template = this.__aistudioRpcRequestTemplate;
      let replayRequest = null;

      if (READ_ONLY_RPC_METHODS.has(rpcMethod) && template) {
        const body = args[0];
        if (
          body === undefined ||
          body === null ||
          typeof body === "string" ||
          body instanceof ArrayBuffer ||
          ArrayBuffer.isView(body)
        ) {
          replayRequest = {
            ...template,
            body,
            withCredentials: Boolean(this.withCredentials),
          };
        }
      }

      if (!this.__aistudioRpcSkipCapture && rpcMethod) {
        this.addEventListener(
          "load",
          () => {
            if (this.status < 200 || this.status >= 300) return;

            let payload = "";
            try {
              payload = this.responseType === "json" ? this.response : this.responseText;
            } catch {
              payload = this.response;
            }
            recordResponse(
              this.__aistudioRpcUrl,
              payload,
              "xhr",
              replayRequest
            );
          },
          { once: true }
        );
      }

      return originalSend.apply(this, args);
    };
  }

  function isFetchReplayRequest(value) {
    return typeof Request === "function" && value instanceof Request;
  }

  function readXhrResponseText(xhr) {
    try {
      if (xhr.responseType === "json") {
        return normalizeResponseText(xhr.response);
      }
      return normalizeResponseText(xhr.responseText);
    } catch {
      return normalizeResponseText(xhr.response);
    }
  }

  function executeXhrReplayRequest(template) {
    return new Promise((resolve, reject) => {
      const xhr = new window.XMLHttpRequest();
      xhr.__aistudioRpcSkipCapture = true;
      xhr.open(template.method || "POST", template.url, true);
      xhr.withCredentials = Boolean(template.withCredentials);
      xhr.timeout = RPC_REPLAY_TIMEOUT_MS;

      for (const [name, value] of template.headers || []) {
        try {
          xhr.setRequestHeader(name, value);
        } catch (error) {
          console.debug(
            `[AI Studio RPC Bridge] Could not replay XHR header ${name}:`,
            error
          );
        }
      }

      xhr.addEventListener(
        "load",
        () => {
          const responseText = readXhrResponseText(xhr);
          resolve({
            ok: xhr.status >= 200 && xhr.status < 300,
            status: xhr.status,
            text: async () => responseText,
          });
        },
        { once: true }
      );
      xhr.addEventListener(
        "error",
        () => reject(new Error("AI Studio XHR replay failed.")),
        { once: true }
      );
      xhr.addEventListener(
        "timeout",
        () => reject(new Error("AI Studio XHR replay timed out.")),
        { once: true }
      );
      xhr.send(template.body ?? null);
    });
  }

  async function executeReplayRequest(replayRequest) {
    if (isFetchReplayRequest(replayRequest)) {
      if (!originalFetchImpl) {
        throw new Error("AI Studio fetch bridge is unavailable.");
      }
      return originalFetchImpl(replayRequest.clone());
    }

    if (replayRequest?.transport === "xhr" && replayRequest.url) {
      return executeXhrReplayRequest(replayRequest);
    }

    throw new Error("No replayable AI Studio request is available.");
  }

  function findCapturedResponse(promptId) {
    const now = Date.now();
    const freshEntries = capturedResponses.filter(
      (entry) => now - entry.capturedAt <= MAX_RESPONSE_AGE_MS
    );
    if (!freshEntries.length) return null;

    const normalizedPromptId =
      typeof promptId === "string" ? promptId.trim() : "";
    if (normalizedPromptId) {
      const matching = freshEntries.find((entry) =>
        entry.responseText.includes(normalizedPromptId)
      );
      if (matching) return matching;
    }

    return freshEntries[0];
  }

  async function refreshReadOnlyResponse(promptId) {
    if (!originalFetchImpl) return null;

    const normalizedPromptId =
      typeof promptId === "string" ? promptId.trim() : "";
    const source = capturedResponses.find(
      (entry) =>
        entry.replayRequest &&
        READ_ONLY_RPC_METHODS.has(entry.method) &&
        (!normalizedPromptId || entry.responseText.includes(normalizedPromptId))
    );
    if (!source) return null;

    try {
      const response = await executeReplayRequest(source.replayRequest);
      if (!response.ok) return null;
      const responseText = await response.text();
      recordResponse(
        source.url,
        responseText,
        `${source.transport}-replay`,
        source.replayRequest
      );
      return findCapturedResponse(promptId);
    } catch (error) {
      console.debug("[AI Studio RPC Bridge] Read-only RPC replay failed:", error);
      return null;
    }
  }

  function parseRpcJson(responseText) {
    if (typeof responseText !== "string" || !responseText.trim()) return null;

    const normalized = responseText
      .trim()
      .replace(/^\)\]\}'\s*/, "")
      .trim();

    try {
      return JSON.parse(normalized);
    } catch {
      return null;
    }
  }

  function getPromptRequestSource() {
    return capturedResponses.find(
      (entry) =>
        entry.replayRequest && READ_ONLY_RPC_METHODS.has(entry.method)
    );
  }

  function buildRpcRequest(source, method, body) {
    if (!source?.replayRequest) return null;

    const url = source.url.replace(
      /MakerSuiteService\/[^/?#]+/,
      `MakerSuiteService/${method}`
    );
    if (url === source.url) return null;

    const template = source.replayRequest;
    if (template?.transport === "xhr") {
      return {
        ...template,
        method: "POST",
        url,
        body: JSON.stringify(body),
      };
    }

    if (!isFetchReplayRequest(template)) return null;
    return new Request(url, {
      method: "POST",
      headers: template.headers,
      body: JSON.stringify(body),
      credentials: template.credentials,
      mode: template.mode,
      redirect: template.redirect,
      referrer: template.referrer,
      referrerPolicy: template.referrerPolicy,
    });
  }

  async function getDriveAccessToken() {
    if (!originalFetchImpl) {
      throw new Error("AI Studio fetch bridge is unavailable.");
    }

    const source = getPromptRequestSource();
    const request = buildRpcRequest(
      source,
      "GenerateAccessToken",
      ["users/me"]
    );
    if (!request) {
      throw new Error("No replayable AI Studio request is available.");
    }

    const response = await executeReplayRequest(request);
    if (!response.ok) {
      throw new Error(`AI Studio access-token request failed (${response.status}).`);
    }

    const payload = parseRpcJson(await response.text());
    const token = Array.isArray(payload)
      ? payload[0]
      : payload?.token || payload?.accessToken;
    if (typeof token !== "string" || !token.trim()) {
      throw new Error("AI Studio did not return a Drive access token.");
    }

    return token.trim();
  }

  function isTextLikeMimeType(mimeType) {
    const value = String(mimeType || "").toLowerCase();
    return (
      value.startsWith("text/") ||
      /(?:^|\/)(?:json|ld\+json|xml|yaml|x-yaml|javascript|x-javascript|sql|rtf)$/.test(
        value
      ) ||
      value.includes("+json") ||
      value.includes("+xml")
    );
  }

  function getGoogleWorkspaceExportMimeType(mimeType) {
    switch (mimeType) {
      case "application/vnd.google-apps.document":
      case "application/vnd.google-apps.presentation":
        return "text/plain";
      case "application/vnd.google-apps.spreadsheet":
        return "text/csv";
      default:
        return null;
    }
  }

  async function fetchDriveRequest(url, options, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      return await originalFetchImpl(url, {
        ...options,
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Drive request timed out after ${timeoutMs}ms.`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function getCachedDriveFile(fileId) {
    const cached = driveFileCache.get(fileId);
    if (!cached) return null;
    if (cached.expiresAt <= Date.now()) {
      cachedDriveTextBytes -= cached.byteLength;
      driveFileCache.delete(fileId);
      return null;
    }

    // Refresh insertion order so frequently reused attachments stay cached.
    driveFileCache.delete(fileId);
    driveFileCache.set(fileId, cached);
    return cached.file;
  }

  function cacheDriveFile(fileId, file) {
    const previous = driveFileCache.get(fileId);
    if (previous) cachedDriveTextBytes -= previous.byteLength;

    const byteLength =
      typeof file?.text === "string" && Number.isFinite(Number(file.byteLength))
        ? Number(file.byteLength)
        : 0;
    driveFileCache.delete(fileId);
    driveFileCache.set(fileId, {
      file,
      byteLength,
      expiresAt: Date.now() + DRIVE_FILE_CACHE_TTL_MS,
    });
    cachedDriveTextBytes += byteLength;

    while (
      driveFileCache.size > MAX_CACHED_DRIVE_FILES ||
      cachedDriveTextBytes > MAX_CACHED_DRIVE_TEXT_BYTES
    ) {
      const oldestKey = driveFileCache.keys().next().value;
      const oldest = driveFileCache.get(oldestKey);
      cachedDriveTextBytes -= oldest?.byteLength || 0;
      driveFileCache.delete(oldestKey);
    }
  }

  async function mapWithConcurrency(items, limit, worker) {
    const results = new Array(items.length);
    let nextIndex = 0;

    async function runWorker() {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        results[index] = await worker(items[index], index);
      }
    }

    const workerCount = Math.min(Math.max(1, limit), items.length);
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
    return results;
  }

  async function fetchDriveFileMetadata(fileId, token) {
    const fields = encodeURIComponent("id,name,mimeType,size,modifiedTime");
    const response = await fetchDriveRequest(
      `${DRIVE_API_ORIGIN}/drive/v3/files/${encodeURIComponent(fileId)}?fields=${fields}&supportsAllDrives=true`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      },
      DRIVE_METADATA_TIMEOUT_MS
    );

    if (!response.ok) {
      throw new Error(`Drive metadata request failed (${response.status}).`);
    }

    return response.json();
  }

  async function readTextResponse(response, byteLimit) {
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > byteLimit) {
      return { text: null, byteLength: contentLength, omittedReason: "too_large" };
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > byteLimit) {
      return {
        text: null,
        byteLength: buffer.byteLength,
        omittedReason: "too_large",
      };
    }

    return {
      text: new TextDecoder("utf-8").decode(buffer),
      byteLength: buffer.byteLength,
      omittedReason: null,
    };
  }

  async function fetchDriveFile(fileId, token, byteLimit) {
    const metadata = await fetchDriveFileMetadata(fileId, token);
    const mimeType = String(metadata?.mimeType || "");
    const exportMimeType = getGoogleWorkspaceExportMimeType(mimeType);

    if (!exportMimeType && !isTextLikeMimeType(mimeType)) {
      return {
        id: fileId,
        name: metadata?.name || null,
        mimeType: mimeType || null,
        size: metadata?.size || null,
        modifiedTime: metadata?.modifiedTime || null,
        text: null,
        omittedReason: "non_text",
      };
    }

    const metadataSize = Number(metadata?.size);
    if (
      !exportMimeType &&
      Number.isFinite(metadataSize) &&
      metadataSize > byteLimit
    ) {
      return {
        id: fileId,
        name: metadata?.name || null,
        mimeType: mimeType || null,
        size: metadata?.size || null,
        modifiedTime: metadata?.modifiedTime || null,
        text: null,
        byteLength: metadataSize,
        omittedReason: "too_large",
      };
    }

    const baseUrl = `${DRIVE_API_ORIGIN}/drive/v3/files/${encodeURIComponent(fileId)}`;
    const contentUrl = exportMimeType
      ? `${baseUrl}/export?mimeType=${encodeURIComponent(exportMimeType)}`
      : `${baseUrl}?alt=media&supportsAllDrives=true`;
    const response = await fetchDriveRequest(
      contentUrl,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      },
      DRIVE_CONTENT_TIMEOUT_MS
    );

    if (!response.ok) {
      throw new Error(`Drive file request failed (${response.status}).`);
    }

    const content = await readTextResponse(response, byteLimit);
    return {
      id: fileId,
      name: metadata?.name || null,
      mimeType: exportMimeType || mimeType || null,
      sourceMimeType: mimeType || null,
      size: metadata?.size || null,
      modifiedTime: metadata?.modifiedTime || null,
      ...content,
    };
  }

  async function fetchDriveFiles(fileIds) {
    const normalizedIds = Array.from(
      new Set(
        (Array.isArray(fileIds) ? fileIds : [])
          .map((value) => String(value || "").trim())
          .filter((value) => /^[A-Za-z0-9_-]{10,200}$/.test(value))
      )
    ).slice(0, MAX_DRIVE_FILE_COUNT);

    if (!normalizedIds.length) return [];

    const files = new Array(normalizedIds.length);
    const pending = [];

    normalizedIds.forEach((fileId, index) => {
      const cached = getCachedDriveFile(fileId);
      if (cached) {
        files[index] = cached;
      } else {
        pending.push({ fileId, index });
      }
    });

    if (pending.length) {
      const token = await getDriveAccessToken();
      const fetchedFiles = await mapWithConcurrency(
        pending,
        MAX_CONCURRENT_DRIVE_FILES,
        async ({ fileId }) => {
          try {
            const file = await fetchDriveFile(
              fileId,
              token,
              MAX_DRIVE_TEXT_BYTES_PER_FILE
            );
            cacheDriveFile(fileId, file);
            return file;
          } catch (error) {
            return {
              id: fileId,
              text: null,
              omittedReason: "unavailable",
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }
      );

      fetchedFiles.forEach((file, pendingIndex) => {
        files[pending[pendingIndex].index] = file;
      });
    }

    let totalTextBytes = 0;
    return files.map((file, index) => {
      if (!file) {
        return {
          id: normalizedIds[index],
          text: null,
          omittedReason: "unavailable",
        };
      }
      if (typeof file.text !== "string") return file;

      const byteLength = Number(file.byteLength);
      if (
        Number.isFinite(byteLength) &&
        totalTextBytes + byteLength > MAX_DRIVE_TEXT_BYTES_TOTAL
      ) {
        return {
          ...file,
          text: null,
          omittedReason: "total_too_large",
        };
      }

      if (Number.isFinite(byteLength)) totalTextBytes += byteLength;
      return file;
    });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;

    if (event.data?.type === DRIVE_FILES_REQUEST_TYPE) {
      const requestId = event.data.requestId;

      (async () => {
        try {
          const files = await fetchDriveFiles(event.data.fileIds);
          window.postMessage(
            {
              type: DRIVE_FILES_RESPONSE_TYPE,
              requestId,
              files,
              error: null,
            },
            "*"
          );
        } catch (error) {
          window.postMessage(
            {
              type: DRIVE_FILES_RESPONSE_TYPE,
              requestId,
              files: [],
              error: error instanceof Error ? error.message : String(error),
            },
            "*"
          );
        }
      })();
      return;
    }

    if (event.data?.type !== REQUEST_TYPE) return;

    const requestId = event.data.requestId;

    (async () => {
      const entry =
        (await refreshReadOnlyResponse(event.data.promptId)) ||
        findCapturedResponse(event.data.promptId);

      window.postMessage(
        {
          type: RESPONSE_TYPE,
          requestId,
          entry: entry
            ? {
                method: entry.method,
                url: entry.url,
                responseText: entry.responseText,
                capturedAt: entry.capturedAt,
                transport: entry.transport,
              }
            : null,
          error: entry
            ? null
            : "No AI Studio prompt RPC has been captured. Refresh this prompt once and try again.",
        },
        "*"
      );
    })();
  });

  patchFetch();
  patchXmlHttpRequest();
  console.debug("[AI Studio RPC Bridge] Ready");
})();
