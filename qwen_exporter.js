(function (root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  if (root && typeof root === "object") {
    root.ParodyQwenExporter = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function asArray(value) {
    return Array.isArray(value) ? value : [];
  }

  function firstString(values) {
    for (const value of values) {
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
  }

  function timestampToMs(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value > 100000000000 ? value : value * 1000;
    }
    if (typeof value === "string" && value.trim()) {
      const numeric = Number(value);
      if (Number.isFinite(numeric) && numeric > 0) {
        return numeric > 100000000000 ? numeric : numeric * 1000;
      }
      const parsed = Date.parse(value);
      return Number.isNaN(parsed) ? 0 : parsed;
    }
    return 0;
  }

  function timestampToIso(value) {
    const timestamp = timestampToMs(value);
    return timestamp ? new Date(timestamp).toISOString() : null;
  }

  function getConversationId(pathname) {
    const match = String(pathname || "").match(
      /(?:^|\/)c\/([0-9a-f-]{36})(?:\/|$)/i
    );
    return match && UUID_PATTERN.test(match[1])
      ? match[1].toLowerCase()
      : null;
  }

  function readableText(value, seen = new Set(), depth = 0) {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value.trim();
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    if (depth > 5 || seen.has(value)) return "";

    if (Array.isArray(value)) {
      seen.add(value);
      const text = value
        .map((item) => readableText(item, seen, depth + 1))
        .filter(Boolean)
        .join("\n\n");
      seen.delete(value);
      return text;
    }

    if (typeof value !== "object") return "";
    seen.add(value);
    const parts = [];
    for (const key of [
      "content",
      "text",
      "message",
      "summary",
      "thought",
      "description",
      "result",
    ]) {
      if (!(key in value)) continue;
      const text = readableText(value[key], seen, depth + 1);
      if (text && !parts.includes(text)) parts.push(text);
    }
    seen.delete(value);
    return parts.join("\n\n");
  }

  function getConversationData(payload) {
    if (!payload || typeof payload !== "object") return {};
    if (payload.data && typeof payload.data === "object") return payload.data;
    return payload;
  }

  function getHistory(payload) {
    const data = getConversationData(payload);
    return data?.chat?.history && typeof data.chat.history === "object"
      ? data.chat.history
      : {};
  }

  function getPagination(payload) {
    const pagination = getHistory(payload).pagination;
    return pagination && typeof pagination === "object" ? pagination : null;
  }

  function messageIdOf(message, fallback = "") {
    return firstString([message?.id, message?.message_id, fallback]);
  }

  function parentIdOf(message) {
    return firstString([message?.parentId, message?.parent_id]);
  }

  function historyMessageMap(payload) {
    const raw = getHistory(payload).messages;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return raw;
  }

  function buildChainFromHistory(payload) {
    const data = getConversationData(payload);
    const history = getHistory(payload);
    const rawMap = historyMessageMap(payload);
    const entries = Object.entries(rawMap)
      .filter(([, message]) => message && typeof message === "object")
      .map(([id, message]) => ({ ...message, id: messageIdOf(message, id) }));
    const byId = new Map(entries.map((message) => [message.id, message]));
    if (!byId.size) {
      return { chain: [], totalCount: 0, branchCount: 0, currentLeafId: null };
    }

    const referencedParents = new Set(
      entries.map(parentIdOf).filter((id) => id && byId.has(id))
    );
    const leaves = entries.filter((message) => !referencedParents.has(message.id));
    const candidates = [];
    for (const value of [
      history.currentId,
      ...asArray(history.currentResponseIds),
      data.currentId,
      ...asArray(data.currentResponseIds),
      ...leaves.map((message) => message.id),
    ]) {
      if (typeof value === "string" && value && !candidates.includes(value)) {
        candidates.push(value);
      }
    }

    let bestChain = [];
    let bestLeafId = null;
    for (const leafId of candidates) {
      const chain = [];
      const seen = new Set();
      let cursor = byId.get(leafId) || null;
      while (cursor && !seen.has(cursor.id)) {
        seen.add(cursor.id);
        chain.unshift(cursor);
        cursor = byId.get(parentIdOf(cursor)) || null;
      }
      if (chain.length > bestChain.length) {
        bestChain = chain;
        bestLeafId = leafId;
      }
    }

    if (!bestChain.length) {
      bestChain = entries.sort((a, b) => {
        const timeDelta = timestampToMs(a.timestamp) - timestampToMs(b.timestamp);
        return timeDelta || a.id.localeCompare(b.id);
      });
      bestLeafId = bestChain.at(-1)?.id || null;
    }

    return {
      chain: bestChain,
      totalCount: entries.length,
      branchCount: Math.max(leaves.length, 1),
      currentLeafId: bestLeafId,
    };
  }

  function getCurrentMessageChain(payload) {
    const data = getConversationData(payload);
    const linear = asArray(data?.chat?.messages).filter(
      (message) => message && typeof message === "object"
    );
    const historyChain = buildChainFromHistory(payload);
    const chain =
      historyChain.chain.length > linear.length ? historyChain.chain : linear;
    return {
      chain,
      totalCount: Math.max(historyChain.totalCount, linear.length),
      branchCount: historyChain.branchCount || (chain.length ? 1 : 0),
      currentLeafId:
        historyChain.currentLeafId || messageIdOf(chain.at(-1)) || null,
    };
  }

  function mergeConversationPayload(basePayload, incomingPayload) {
    if (!basePayload || typeof basePayload !== "object") return incomingPayload;
    if (!incomingPayload || typeof incomingPayload !== "object") return basePayload;

    const baseData = getConversationData(basePayload);
    const incomingData = getConversationData(incomingPayload);
    const baseChat = baseData.chat || (baseData.chat = {});
    const incomingChat = incomingData.chat || {};
    const baseHistory = baseChat.history || (baseChat.history = {});
    const incomingHistory = incomingChat.history || {};

    baseHistory.messages = {
      ...(incomingHistory.messages || {}),
      ...(baseHistory.messages || {}),
    };
    if (incomingHistory.pagination) {
      baseHistory.pagination = incomingHistory.pagination;
    }
    for (const key of ["currentId", "currentResponseIds"]) {
      if (!baseHistory[key] && incomingHistory[key]) {
        baseHistory[key] = incomingHistory[key];
      }
    }
    if (!baseChat.messages?.length && incomingChat.messages?.length) {
      baseChat.messages = incomingChat.messages;
    }
    return basePayload;
  }

  function normalizeFileKind(file) {
    const raw = firstString([
      file?.file_type,
      file?.type,
      file?.showType,
      file?.mime_type,
      file?.mimeType,
    ]).toLowerCase();
    const url = firstString([file?.url, file?.file?.url]).toLowerCase();
    if (raw.includes("image") || /\.(png|jpe?g|gif|webp|avif)(?:[?#]|$)/i.test(url)) {
      return "image";
    }
    if (raw.includes("video") || /\.(mp4|webm|mov)(?:[?#]|$)/i.test(url)) {
      return "video";
    }
    if (raw.includes("audio") || /\.(mp3|wav|m4a|ogg)(?:[?#]|$)/i.test(url)) {
      return "audio";
    }
    return "file";
  }

  function collectAttachments(message) {
    const attachments = [];
    const seen = new Set();
    asArray(message?.files).forEach((file, index) => {
      if (!file || typeof file !== "object") return;
      const nested = file.file && typeof file.file === "object" ? file.file : {};
      const nestedMeta =
        nested.meta && typeof nested.meta === "object" ? nested.meta : {};
      const url = firstString([
        file.url,
        file.download_url,
        file.downloadUrl,
        nested.url,
      ]);
      const id = firstString([file.id, nested.id]);
      const name =
        firstString([
          file.name,
          nested.filename,
          nestedMeta.name,
          file.filename,
        ]) || `attachment_${index + 1}`;
      const key = url || id || name;
      if (seen.has(key)) return;
      seen.add(key);
      attachments.push({
        kind: normalizeFileKind(file),
        name,
        url: url || null,
        id: id || null,
        mimeType:
          firstString([file.mime_type, file.mimeType, file.file_type]) || null,
        size:
          Number.isFinite(Number(file.size ?? nestedMeta.size))
            ? Number(file.size ?? nestedMeta.size)
            : null,
      });
    });
    return attachments;
  }

  function citationFromValue(value) {
    if (!value || typeof value !== "object") return null;
    const url = firstString([
      value.url,
      value.link,
      value.source_url,
      value.sourceUrl,
    ]);
    if (!url) return null;
    return {
      title: firstString([value.title, value.name, value.hostname]) || url,
      url,
      snippet: firstString([value.snippet, value.description, value.text]),
    };
  }

  function collectCitations(message) {
    const citations = [];
    const seen = new Set();
    const addValues = (values) => {
      asArray(values).forEach((value) => {
        const citation = citationFromValue(value);
        if (!citation || seen.has(citation.url)) return;
        seen.add(citation.url);
        citations.push(citation);
      });
    };

    asArray(message?.content_list).forEach((item) => {
      const extra = item?.extra && typeof item.extra === "object" ? item.extra : {};
      addValues(extra.web_search_info);
      addValues(extra.search_result);
      addValues(extra.tool_result?.docs);
    });
    return citations;
  }

  function getAnswerText(message) {
    const answers = [];
    asArray(message?.content_list).forEach((item) => {
      const phase = String(item?.phase || "").toLowerCase();
      const role = String(item?.role || "").toLowerCase();
      if (role === "function") return;
      if (!/(?:^|_)(answer|final|deepthinking)(?:_|$)/.test(phase)) return;
      const text = readableText(item.content);
      if (text && !answers.includes(text)) answers.push(text);
    });
    if (answers.length) return answers.join("\n\n");
    return readableText(message?.content);
  }

  function getThinkingText(message) {
    const parts = [];
    const topLevel = readableText(message?.reasoning_content);
    if (topLevel) parts.push(topLevel);

    asArray(message?.content_list).forEach((item) => {
      const phase = String(item?.phase || "").toLowerCase();
      if (!/(thinking|reasoning|analysis)/.test(phase)) return;
      const extra = item?.extra && typeof item.extra === "object" ? item.extra : {};
      const title = readableText(extra.summary_title);
      const thought = readableText(extra.summary_thought);
      const content = readableText(item.content);
      const section = [title, thought, content]
        .filter((text, index, values) => text && values.indexOf(text) === index)
        .join("\n\n");
      if (section && !parts.includes(section)) parts.push(section);
    });
    return parts.join("\n\n");
  }

  function escapeLabel(value) {
    return String(value || "attachment").replace(/[\[\]]/g, "\\$&");
  }

  function appendReferences(text, attachments, citations) {
    const sections = [];
    if (attachments.length) {
      const lines = attachments.map((attachment) => {
        const label = escapeLabel(attachment.name || attachment.id);
        if (attachment.url && attachment.kind === "image") {
          return `![${label}](${attachment.url})`;
        }
        if (attachment.url) return `- [${label}](${attachment.url})`;
        return `- ${label}${attachment.id ? ` (${attachment.id})` : ""}`;
      });
      const allImages = attachments.every(
        (attachment) => attachment.kind === "image" && attachment.url
      );
      sections.push(allImages ? lines.join("\n\n") : `### Attachments\n${lines.join("\n")}`);
    }

    if (citations.length) {
      sections.push(
        `### Sources\n${citations
          .map((citation, index) => {
            const snippet = citation.snippet
              ? ` — ${citation.snippet.replace(/\s+/g, " ").trim()}`
              : "";
            return `${index + 1}. [${escapeLabel(citation.title)}](${citation.url})${snippet}`;
          })
          .join("\n")}`
      );
    }

    return [String(text || "").trim(), ...sections].filter(Boolean).join("\n\n");
  }

  function normalizeMessage(message, domOrder) {
    const rawRole = String(message?.role || "").toLowerCase();
    const role = rawRole === "user" ? "user" : rawRole === "assistant" ? "model" : null;
    if (!role) return null;

    const attachments = collectAttachments(message);
    const citations = role === "model" ? collectCitations(message) : [];
    const baseText = role === "user" ? readableText(message.content) : getAnswerText(message);
    let renderedText = appendReferences(baseText, attachments, citations);
    const thoughtText = role === "model" ? getThinkingText(message) : "";
    const emptyResponse = role === "model" && !renderedText && !thoughtText;
    if (emptyResponse) {
      renderedText = "[Empty Qwen response]";
    }
    const createdAtUtc = timestampToIso(message.timestamp);
    const model = firstString([
      message.modelName,
      message.model,
      ...asArray(message.models),
    ]);

    return {
      domOrder,
      type: role,
      userText: role === "user" ? renderedText : null,
      thoughtText: role === "model" ? thoughtText || null : null,
      responseText: role === "model" ? renderedText : null,
      images: [],
      videos: [],
      attachments,
      citations,
      qwenMedia: attachments
        .filter(
          (attachment) =>
            attachment.url &&
            (attachment.kind === "image" || attachment.kind === "video")
        )
        .map((attachment) => ({
          kind: attachment.kind,
          url: attachment.url,
          alt: attachment.name,
        })),
      responseId: messageIdOf(message) || null,
      parentResponseId: parentIdOf(message) || null,
      turnId: firstString([message.turn_id, message.turnId]) || null,
      createdAtUtc,
      model: model || null,
      emptyResponse,
    };
  }

  function processConversation(payload, options = {}) {
    const data = getConversationData(payload);
    const chainInfo = getCurrentMessageChain(payload);
    const messages = chainInfo.chain
      .map((message, index) => normalizeMessage(message, index))
      .filter(
        (message) =>
          message &&
          (message.userText || message.responseText || message.thoughtText)
      );

    if (!messages.length) {
      throw new Error("Qwen returned no exportable conversation messages.");
    }

    const userMessageCount = messages.filter(
      (message) => message.type === "user"
    ).length;
    const assistantMessageCount = messages.filter(
      (message) => message.type === "model"
    ).length;
    const thinkingMessageCount = messages.filter(
      (message) => message.type === "model" && message.thoughtText
    ).length;
    const attachmentCount = messages.reduce(
      (count, message) => count + message.attachments.length,
      0
    );
    const citationCount = messages.reduce(
      (count, message) => count + message.citations.length,
      0
    );
    const messageModels = messages.map((message) => message.model).filter(Boolean);
    const messageTimes = messages
      .map((message) => timestampToMs(message.createdAtUtc))
      .filter(Boolean);

    return {
      messages,
      meta: {
        source: "Qwen",
        model: messageModels.at(-1) || "Qwen",
        apiModel: messageModels.at(-1) || null,
        platform: "QWEN",
        extractionMode: options.extractionMode || "qwen_api",
        conversationUuid:
          firstString([data.id, options.conversationId]) || null,
        conversationTitle: firstString([data.title, options.title]) || null,
        createdAtUtc:
          timestampToIso(data.created_at) ||
          (messageTimes.length
            ? new Date(Math.min(...messageTimes)).toISOString()
            : null),
        updatedAtUtc:
          timestampToIso(data.updated_at) ||
          (messageTimes.length
            ? new Date(Math.max(...messageTimes)).toISOString()
            : null),
        currentLeafMessageUuid: chainInfo.currentLeafId,
        totalConversationMessageCount: chainInfo.totalCount,
        exportedMessageCount: messages.length,
        userMessageCount,
        assistantMessageCount,
        thinkingMessageCount,
        attachmentCount,
        citationCount,
        branchCount: chainInfo.branchCount,
        artifactCount: 0,
        researchTaskCount: 0,
        presentedFileCount: 0,
      },
    };
  }

  return {
    getConversationId,
    getConversationData,
    getHistory,
    getPagination,
    getCurrentMessageChain,
    mergeConversationPayload,
    collectAttachments,
    collectCitations,
    getAnswerText,
    getThinkingText,
    normalizeMessage,
    processConversation,
    timestampToIso,
  };
});
