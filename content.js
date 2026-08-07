(function () {
  "use strict";

  // Configuration
  const SCROLL_DELAY_MS = 50;
  const MAX_SCROLL_ATTEMPTS = 10000;
  const BOTTOM_DETECTION_TOLERANCE = 10;
  const MIN_SCROLL_DISTANCE_THRESHOLD = 5;
  const SCROLL_INCREMENT_INITIAL = 150;
  const FINAL_COLLECTION_DELAY_MS = 300;

  let isScrolling = false;
  let collectedData = new Map();
  let scrollCount = 0;
  let abortController = null;

  // Helper: Delay
  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Helper: Log to popup
  function logToPopup(message, type = "info") {
    chrome.runtime.sendMessage({
      action: "UPDATE_STATUS",
      message: message,
      type: type,
    });
  }

  // Helper: Get Trusted HTML (CSP)
  let trustedTypesPolicy = null;
  if (window.trustedTypes && window.trustedTypes.createPolicy) {
    try {
      trustedTypesPolicy = window.trustedTypes.createPolicy(
        "aistudio-export-policy#extension",
        {
          createHTML: (string) => string,
        }
      );
    } catch (e) {
      console.warn("Trusted Types policy creation failed", e);
    }
  }
  function getTrustedHTML(htmlString) {
    return trustedTypesPolicy
      ? trustedTypesPolicy.createHTML(htmlString)
      : htmlString;
  }

  // 1. Find Scroller
  function getMainScrollerElement() {
    let scroller = document.querySelector("ms-autoscroll-container");
    if (scroller) return scroller;

    const chatTurnsContainer =
      document.querySelector("ms-chat-turn")?.parentElement;
    if (chatTurnsContainer) {
      let parent = chatTurnsContainer;
      for (let i = 0; i < 5 && parent; i++) {
        if (
          parent.scrollHeight > parent.clientHeight + 10 &&
          (window.getComputedStyle(parent).overflowY === "auto" ||
            window.getComputedStyle(parent).overflowY === "scroll")
        ) {
          return parent;
        }
        parent = parent.parentElement;
      }
    }
    return document.documentElement;
  }

  // 2. Expand Thinking
  async function expandThinkingSections(modelDiv) {
    let expanded = false;
    try {
      // Strategy 1: Panels
      const collapsedPanels = modelDiv.querySelectorAll(
        'mat-expansion-panel[aria-expanded="false"]'
      );
      for (const panel of collapsedPanels) {
        const headerText =
          panel
            .querySelector(".mat-expansion-panel-header-title")
            ?.textContent?.toLowerCase() || "";
        if (headerText.includes("thought") || headerText.includes("thinking")) {
          panel.querySelector("button")?.click();
          expanded = true;
        }
      }
      // Strategy 2: Buttons
      const buttons = modelDiv.querySelectorAll("button");
      for (const btn of buttons) {
        const txt = btn.textContent?.toLowerCase() || "";
        if (
          (txt.includes("expand") || txt.includes("show more")) &&
          txt.includes("thought")
        ) {
          btn.click();
          expanded = true;
        }
      }
      if (expanded) await delay(500);
    } catch (e) {
      console.warn("Error expanding thinking:", e);
    }
  }

  // 3. Extract Data
  async function extractDataIncremental(options = {}) {
    const captureMedia = options.captureMedia !== false;
    const expandThinking = options.expandThinking !== false;
    let newlyFound = false;
    const currentTurns = document.querySelectorAll("ms-chat-turn");

    for (const [index, turn] of currentTurns.entries()) {
      const turnKey = turn; // Use element as key
      const turnContainer = turn.querySelector(
        ".chat-turn-container.user, .chat-turn-container.model"
      );
      if (!turnContainer) continue;

      if (!collectedData.has(turnKey)) {
        collectedData.set(turnKey, {
          domOrder: index,
          type: "unknown",
          userText: null,
          thoughtText: null,
          responseText: null,
          codeBlocks: [],
          images: [], // Store base64 images
          videos: [], // Store base64 videos
        });
        newlyFound = true;
      }

      let info = collectedData.get(turnKey);
      let updated = false;
      const mediaNodeCount = turn.querySelectorAll(
        "ms-image-chunk img[src], ms-video-chunk video[src]"
      ).length;

      if (turnContainer.classList.contains("user")) {
        info.type = "user";
        const canSkipUserPass =
          !captureMedia &&
          !!info.userText &&
          info.lastUserMediaCount === mediaNodeCount;
        if (canSkipUserPass) continue;

        // 1. Extract Text (only if not yet extracted)
        if (!info.userText) {
          let textParts = [];

          // Strategy 1: Raw Text Container (Often most reliable for user input)
          const raw = turn.querySelector(
            "ms-text-chunk .very-large-text-container"
          );
          if (raw) {
            textParts.push(raw.textContent.trim());
          } else {
            // Strategy 2: Rendered Markdown Node
            const node = turn.querySelector("ms-cmark-node");
            if (node) textParts.push(node.innerText.trim());
            else {
              // Strategy 3: Fallback to any text content in the turn
              const content = turn.querySelector(".turn-content");
              if (content) textParts.push(content.innerText.trim());
            }
          }

          if (textParts.length > 0) {
            info.userText = textParts.join("\n\n");
            updated = true;
            console.log(
              `[Turn ${index}] Extracted User text: ${info.userText.substring(
                0,
                30
              )}...`
            );
          }
        }

        // 2. Extract Images (Always check, as they might lazy load)
        const images = turn.querySelectorAll("ms-image-chunk img");
        if (images.length > 0) {
          // Initialize collected URLs set if not exists
          if (!info.collectedImageUrls) info.collectedImageUrls = new Set();

          for (const img of images) {
            const src = img.src;
            const alt = img.alt || "image";

            // Skip if already collected
            if (src && !info.collectedImageUrls.has(src)) {
              console.log("Found new image:", src);
              info.collectedImageUrls.add(src);

              // Keep a lightweight reference in markdown text.
              if (!info.userText) info.userText = "";
              const imageReference = isEmbeddedDataUrl(src)
                ? buildEmbeddedAssetPlaceholder("image", alt)
                : `![${alt}](${src})`;
              if (!info.userText.includes(imageReference)) {
                info.userText += `${info.userText.trim() ? "\n\n" : ""}${imageReference}`;
                updated = true;
              }

              // Base64 capture is only needed for media-embedded formats (HTML/JSON).
              if (captureMedia) {
                try {
                  const base64 = await fetchAsBase64(src);
                  if (base64) {
                    info.images.push({ alt, base64 });
                    updated = true;
                  }
                } catch (e) {
                  console.error("Failed to convert image to base64:", e);
                }
              }
            }
          }
        }

        // 3. Extract Videos (Always check)
        const videos = turn.querySelectorAll("ms-video-chunk");

        if (videos.length > 0) {
          if (!info.collectedVideoUrls) info.collectedVideoUrls = new Set();

          for (const [videoIdx, chunk] of videos.entries()) {
            const video = chunk.querySelector("video");
            const nameSpan = chunk.querySelector(".file-chunk-container .name");

            if (video && video.src && !info.collectedVideoUrls.has(video.src)) {
              let filename = nameSpan
                ? nameSpan.textContent.trim()
                : `video_${videoIdx}.mp4`;
              filename = filename.replace(/[<>:"/\\|?*]/g, "_");

              info.collectedVideoUrls.add(video.src);

              if (!info.userText) info.userText = "";
              if (!info.userText.includes(video.src)) {
                info.userText += `${info.userText.trim() ? "\n\n" : ""}[${filename}](${video.src})`;
                updated = true;
              }

              if (captureMedia) {
                try {
                  const base64 = await fetchAsBase64(video.src);
                  if (base64) {
                    info.videos.push({ filename, base64 });
                    updated = true;
                  }
                } catch (e) {
                  console.error(
                    `[Turn ${index}] ✗ Error processing video ${videoIdx}:`,
                    e
                  );
                }
              }
            }
          }
        }
        info.lastUserMediaCount = mediaNodeCount;
      } else if (turnContainer.classList.contains("model")) {
        info.type = "model";
        const modelDone = info.responseText && (info.thoughtText || !expandThinking);
        if (modelDone) continue;

        // Thought
        if (!info.thoughtText && expandThinking) {
          await expandThinkingSections(turn);
          const rawThought = turn.querySelector(
            "ms-thought-chunk .very-large-text-container"
          );
          if (rawThought) info.thoughtText = rawThought.textContent.trim();
          else {
            const thoughtNode = turn.querySelector(
              "ms-thought-chunk .mat-expansion-panel-body ms-cmark-node"
            );
            if (thoughtNode) info.thoughtText = thoughtNode.textContent.trim();
          }
          if (info.thoughtText) updated = true;
        }

        // Response
        if (!info.responseText) {
          // Strategy 1: Find all prompt chunks that are NOT thoughts
          const responseChunks = Array.from(
            turn.querySelectorAll(".turn-content > ms-prompt-chunk")
          );

          let texts = [];

          if (responseChunks.length > 0) {
            texts = responseChunks
              .filter((chunk) => !chunk.querySelector("ms-thought-chunk"))
              .map((chunk) => {
                // Sub-Strategy A: Rendered Markdown (Best for formatting)
                const cmark = chunk.querySelector("ms-cmark-node");
                if (cmark) return cmark.innerText.trim();

                // Sub-Strategy B: Raw Text
                const raw = chunk.querySelector(
                  "ms-text-chunk .very-large-text-container"
                );
                if (raw) return raw.textContent.trim();

                // Sub-Strategy C: Chunk Text
                return chunk.innerText.trim();
              })
              .filter((t) => t);
          } else {
            // Strategy 2: If no prompt chunks found (rare, but possible if DOM changed), look for cmark nodes directly in turn content
            const directCmarks = turn.querySelectorAll(
              ".turn-content > ms-cmark-node"
            );
            if (directCmarks.length > 0) {
              texts = Array.from(directCmarks).map((n) => n.innerText.trim());
            }
          }

          if (texts.length > 0) {
            info.responseText = texts.join("\n\n");
            updated = true;
            console.log(
              `[Turn ${index}] Extracted Model text: ${info.responseText.substring(
                0,
                30
              )}...`
            );
          } else if (!info.thoughtText) {
            // Strategy 3: Ultimate Fallback
            const content = turn.querySelector(".turn-content");
            if (content) {
              info.responseText = content.innerText.trim();
              updated = true;
              console.log(
                `[Turn ${index}] Extracted Model text (Fallback): ${info.responseText.substring(
                  0,
                  30
                )}...`
              );
            }
          }
        }
      }

      if (updated) collectedData.set(turnKey, info);
    }
    return newlyFound;
  }

  // 4. Auto Scroll
  async function autoScroll(options = {}) {
    isScrolling = true;
    collectedData.clear();
    scrollCount = 0;

    const scroller = getMainScrollerElement();
    if (!scroller) throw new Error("Scroll container not found");

    const isWindow =
      scroller === document.documentElement || scroller === document.body;

    // Preload history (scroll up a bit)
    if (isWindow) window.scrollTo({ top: 0 });
    else scroller.scrollTo({ top: 0 });
    await delay(1000);

    logToPopup("Scraping started...");
    await extractDataIncremental(options);

    let reachedEnd = false;

    while (scrollCount < MAX_SCROLL_ATTEMPTS && !reachedEnd && isScrolling) {
      if (abortController?.signal.aborted) break;

      const currentTop = isWindow ? window.scrollY : scroller.scrollTop;
      const scrollHeight = isWindow
        ? document.documentElement.scrollHeight
        : scroller.scrollHeight;
      const clientHeight = isWindow
        ? window.innerHeight
        : scroller.clientHeight;

      if (
        scrollCount > 0 &&
        currentTop + clientHeight >= scrollHeight - BOTTOM_DETECTION_TOLERANCE
      ) {
        reachedEnd = true;
        break;
      }

      const scrollIncrement = Math.max(
        SCROLL_INCREMENT_INITIAL,
        Math.floor(clientHeight * 0.85)
      );
      const target = currentTop + scrollIncrement;
      if (isWindow) window.scrollTo(0, target);
      else scroller.scrollTop = target;

      scrollCount++;
      await delay(SCROLL_DELAY_MS);

      const newTop = isWindow ? window.scrollY : scroller.scrollTop;
      if (
        newTop - currentTop < MIN_SCROLL_DISTANCE_THRESHOLD &&
        scrollCount > 5
      ) {
        reachedEnd = true;
        break;
      }

      await extractDataIncremental(options);

      if (scrollCount % 10 === 0) {
        logToPopup(
          `Scrolled ${scrollCount} times... (${collectedData.size} msgs)`
        );
      }
    }

    // Final passes
    logToPopup("Finalizing...");
    if (isWindow) window.scrollTo(0, 0);
    else scroller.scrollTop = 0;
    await delay(FINAL_COLLECTION_DELAY_MS);
    await extractDataIncremental(options);

    if (isWindow) window.scrollTo(0, document.documentElement.scrollHeight);
    else scroller.scrollTop = scroller.scrollHeight;
    await delay(FINAL_COLLECTION_DELAY_MS);
    await extractDataIncremental(options);

    isScrolling = false;
    return true;
  }

  // --- Google AI Studio Logic (RPC Based) ---

  const AISTUDIO_RPC_REQUEST_TYPE = "AISTUDIO_RPC_DATA_REQUEST";
  const AISTUDIO_RPC_RESPONSE_TYPE = "AISTUDIO_RPC_DATA_RESULT";
  const AISTUDIO_DRIVE_FILES_REQUEST_TYPE = "AISTUDIO_DRIVE_FILES_REQUEST";
  const AISTUDIO_DRIVE_FILES_RESPONSE_TYPE = "AISTUDIO_DRIVE_FILES_RESULT";
  const AISTUDIO_RPC_TIMEOUT_MS = 2500;
  const AISTUDIO_DRIVE_FILES_TIMEOUT_MS = 30000;
  const AISTUDIO_PROMPT_ONEOF_FIELDS = [2, 3, 7, 14, 15, 16, 17, 18, 22];
  const AISTUDIO_CHUNK_ONEOF_FIELDS = [
    1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 13, 14, 18, 21, 24,
  ];

  function getAIStudioPromptIdFromUrl(pathname = location.pathname) {
    const match = String(pathname || "").match(/^\/prompts\/([^/?#]+)/i);
    if (!match) return null;

    const promptId = decodeURIComponent(match[1]);
    if (/^new(?:_|-)/i.test(promptId)) return null;
    return promptId;
  }

  function requestAIStudioRpcCapture(promptId) {
    return new Promise((resolve, reject) => {
      const requestId =
        typeof crypto?.randomUUID === "function"
          ? crypto.randomUUID()
          : `aistudio-${Date.now()}-${Math.random().toString(16).slice(2)}`;

      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        window.removeEventListener("message", listener);
        callback(value);
      };

      const listener = (event) => {
        if (
          event.source !== window ||
          event.data?.type !== AISTUDIO_RPC_RESPONSE_TYPE ||
          event.data?.requestId !== requestId
        ) {
          return;
        }

        if (event.data.entry) {
          finish(resolve, event.data.entry);
        } else {
          finish(
            reject,
            new Error(event.data.error || "AI Studio prompt RPC was not captured.")
          );
        }
      };

      const timeoutId = setTimeout(() => {
        finish(
          reject,
          new Error(
            "AI Studio RPC bridge did not respond. Reload this prompt after reloading the extension."
          )
        );
      }, AISTUDIO_RPC_TIMEOUT_MS);

      window.addEventListener("message", listener);
      window.postMessage(
        {
          type: AISTUDIO_RPC_REQUEST_TYPE,
          requestId,
          promptId,
        },
        "*"
      );
    });
  }

  function requestAIStudioDriveFiles(fileIds) {
    return new Promise((resolve, reject) => {
      const requestId =
        typeof crypto?.randomUUID === "function"
          ? crypto.randomUUID()
          : `aistudio-drive-${Date.now()}-${Math.random().toString(16).slice(2)}`;

      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        window.removeEventListener("message", listener);
        callback(value);
      };

      const listener = (event) => {
        if (
          event.source !== window ||
          event.data?.type !== AISTUDIO_DRIVE_FILES_RESPONSE_TYPE ||
          event.data?.requestId !== requestId
        ) {
          return;
        }

        if (event.data.error) {
          finish(reject, new Error(event.data.error));
        } else {
          finish(resolve, Array.isArray(event.data.files) ? event.data.files : []);
        }
      };

      const timeoutId = setTimeout(() => {
        finish(reject, new Error("AI Studio attachment retrieval timed out."));
      }, AISTUDIO_DRIVE_FILES_TIMEOUT_MS);

      window.addEventListener("message", listener);
      window.postMessage(
        {
          type: AISTUDIO_DRIVE_FILES_REQUEST_TYPE,
          requestId,
          fileIds,
        },
        "*"
      );
    });
  }

  function parseAIStudioRpcJson(responseText) {
    if (typeof responseText !== "string" || !responseText.trim()) {
      throw new Error("AI Studio RPC response was empty.");
    }

    const normalized = responseText
      .trim()
      .replace(/^\)\]\}'\s*/, "")
      .trim();

    try {
      return JSON.parse(normalized);
    } catch (error) {
      throw new Error(`Could not parse AI Studio JSPB response: ${error.message}`);
    }
  }

  function isPlainObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  /**
   * Google JSON+Protobuf (JSPB) stores ordinary fields at fieldNumber - 1 and
   * may move sparse/high-numbered fields into a trailing numeric-key object.
   */
  function getAIStudioJspbField(message, fieldNumber) {
    if (!Array.isArray(message) || fieldNumber < 1) return undefined;

    const tail = message[message.length - 1];
    const tailIsSparseFieldMap =
      isPlainObject(tail) &&
      Object.keys(tail).some((key) => /^\d+$/.test(key));
    const direct = message[fieldNumber - 1];
    if (direct !== undefined && !(direct === tail && tailIsSparseFieldMap)) {
      return direct;
    }

    if (
      tailIsSparseFieldMap &&
      Object.prototype.hasOwnProperty.call(tail, fieldNumber)
    ) {
      return tail[fieldNumber];
    }

    return undefined;
  }

  function getAIStudioPromptArray(rpcEntry) {
    let payload = parseAIStudioRpcJson(rpcEntry.responseText);
    if (isPlainObject(payload)) {
      payload = payload.result || payload.response || payload.data || payload;
    }

    if (!Array.isArray(payload)) {
      throw new Error("AI Studio RPC did not return a JSPB array.");
    }

    if (rpcEntry.method === "ResolveDriveResource") {
      payload = getAIStudioJspbField(payload, 1);
    }

    if (!Array.isArray(payload)) {
      throw new Error("AI Studio RPC response did not contain a Prompt resource.");
    }

    return payload;
  }

  function getAIStudioOneofField(message, candidates) {
    for (const fieldNumber of candidates) {
      const value = getAIStudioJspbField(message, fieldNumber);
      if (value !== undefined && value !== null) {
        return { fieldNumber, value };
      }
    }
    return { fieldNumber: null, value: undefined };
  }

  function getAIStudioRepeatedMessages(value) {
    return Array.isArray(value) ? value.filter(Array.isArray) : [];
  }

  function getAIStudioNestedId(value) {
    const id = getAIStudioJspbField(value, 1);
    return typeof id === "string" && id.trim() ? id.trim() : null;
  }

  function getAIStudioInlineAsset(value) {
    if (!Array.isArray(value)) return null;
    const mimeType = getAIStudioJspbField(value, 1);
    const base64 = getAIStudioJspbField(value, 2);
    if (typeof base64 !== "string" || !base64) return null;

    return {
      mimeType:
        typeof mimeType === "string" && mimeType
          ? mimeType
          : "application/octet-stream",
      base64,
    };
  }

  function getAIStudioTimestamp(value) {
    if (!Array.isArray(value)) return null;
    const rawSeconds = getAIStudioJspbField(value, 1);
    const rawNanos = getAIStudioJspbField(value, 2);
    const seconds = Number(rawSeconds);
    const nanos = Number(rawNanos || 0);
    if (!Number.isFinite(seconds)) return null;
    return seconds * 1000 + Math.floor(nanos / 1e6);
  }

  function appendAIStudioText(current, next) {
    const value = typeof next === "string" ? next.trim() : "";
    if (!value) return current || "";
    return current ? `${current}\n\n${value}` : value;
  }

  function formatAIStudioDriveAsset(kind, id, driveFile) {
    const name =
      typeof driveFile?.name === "string" && driveFile.name.trim()
        ? driveFile.name.trim()
        : null;
    const mimeType =
      typeof driveFile?.mimeType === "string" && driveFile.mimeType.trim()
        ? driveFile.mimeType.trim()
        : null;

    if (typeof driveFile?.text === "string") {
      const label = name || `AI Studio ${kind} asset ${id}`;
      const suffix = mimeType ? ` (${mimeType})` : "";
      return `**Attached text — ${label}${suffix}:**\n\n${driveFile.text}`;
    }

    const metadata = [name, mimeType].filter(Boolean).join(", ");
    return metadata
      ? `[AI Studio ${kind} asset: ${id} — ${metadata}]`
      : `[AI Studio ${kind} asset: ${id}]`;
  }

  function getAIStudioChunkContent(chunk, driveFilesById = null) {
    const role =
      String(getAIStudioJspbField(chunk, 9) || "user").toLowerCase() ===
      "model"
        ? "model"
        : "user";
    const thought = Boolean(getAIStudioJspbField(chunk, 20));
    const timestamp = getAIStudioTimestamp(getAIStudioJspbField(chunk, 33));
    const { fieldNumber, value } = getAIStudioOneofField(
      chunk,
      AISTUDIO_CHUNK_ONEOF_FIELDS
    );

    const result = {
      role,
      thought,
      timestamp,
      text: "",
      images: [],
      videos: [],
      attachmentCount: 0,
    };

    switch (fieldNumber) {
      case 1:
        result.text = typeof value === "string" ? value : "";
        break;
      case 2:
      case 3:
      case 4:
      case 6: {
        const labels = {
          2: "image",
          3: "video",
          4: "file",
          6: "audio",
        };
        const id = getAIStudioNestedId(value);
        const driveFile = id ? driveFilesById?.get(id) : null;
        result.text = id
          ? formatAIStudioDriveAsset(labels[fieldNumber], id, driveFile)
          : `[AI Studio ${labels[fieldNumber]} asset]`;
        result.attachmentCount = 1;
        break;
      }
      case 7:
        result.text =
          typeof value === "string"
            ? `![AI Studio image](${value})`
            : "[AI Studio image]";
        result.attachmentCount = 1;
        break;
      case 8:
        result.text =
          typeof value === "string"
            ? `[AI Studio video](${value})`
            : "[AI Studio video]";
        result.attachmentCount = 1;
        break;
      case 13:
      case 18:
      case 24: {
        const asset = getAIStudioInlineAsset(value);
        const kind =
          fieldNumber === 13 ? "image" : fieldNumber === 18 ? "audio" : "file";
        result.text = `[Embedded ${kind} captured from AI Studio RPC]`;
        result.attachmentCount = 1;
        if (asset && fieldNumber === 13) {
          result.images.push({
            alt: "AI Studio image",
            base64: `data:${asset.mimeType};base64,${asset.base64}`,
          });
        }
        break;
      }
      case 14: {
        const videoId = getAIStudioNestedId(value);
        result.text = videoId
          ? `[YouTube video](https://www.youtube.com/watch?v=${encodeURIComponent(videoId)})`
          : "[YouTube video]";
        result.attachmentCount = 1;
        break;
      }
      case 11: {
        const languageCode = Number(getAIStudioJspbField(value, 1));
        const code = getAIStudioJspbField(value, 2);
        const language = languageCode === 1 ? "python" : "text";
        result.text =
          typeof code === "string" ? `\`\`\`${language}\n${code}\n\`\`\`` : "";
        break;
      }
      case 12: {
        const output = getAIStudioJspbField(value, 2);
        result.text =
          typeof output === "string" ? `\`\`\`text\n${output}\n\`\`\`` : "";
        break;
      }
      case 21: {
        const functionCall = getAIStudioJspbField(value, 1);
        const functionName = getAIStudioJspbField(functionCall, 1);
        result.text = functionName
          ? `[Function call: ${functionName}]`
          : "[Function call]";
        break;
      }
      default:
        break;
    }

    const errorMessage = getAIStudioJspbField(chunk, 29);
    if (typeof errorMessage === "string" && errorMessage.trim()) {
      result.text = appendAIStudioText(
        result.text,
        `[AI Studio error: ${errorMessage.trim()}]`
      );
    }

    return result;
  }

  function getAIStudioChatPayloads(prompt) {
    const promptType = getAIStudioOneofField(
      prompt,
      AISTUDIO_PROMPT_ONEOF_FIELDS
    );

    if (promptType.fieldNumber === 14 && Array.isArray(promptType.value)) {
      return [promptType.value];
    }

    // Comparison prompts contain repeated branches; each branch's first field
    // contains the same chat-prompt structure used by ordinary prompts.
    if (promptType.fieldNumber === 15 && Array.isArray(promptType.value)) {
      const branches = getAIStudioRepeatedMessages(
        getAIStudioJspbField(promptType.value, 1)
      );
      return branches
        .map((branch) => getAIStudioJspbField(branch, 1))
        .filter(Array.isArray);
    }

    throw new Error(
      `Unsupported AI Studio prompt type (${promptType.fieldNumber || "unknown"}).`
    );
  }

  function collectAIStudioDriveFileIds(prompt) {
    const ids = new Set();
    const driveAssetFields = new Set([2, 3, 4, 6]);

    getAIStudioChatPayloads(prompt).forEach((chatPayload) => {
      const chunks = getAIStudioRepeatedMessages(
        getAIStudioJspbField(chatPayload, 1)
      );

      chunks.forEach((chunk) => {
        const { fieldNumber, value } = getAIStudioOneofField(
          chunk,
          AISTUDIO_CHUNK_ONEOF_FIELDS
        );
        if (!driveAssetFields.has(fieldNumber)) return;

        const id = getAIStudioNestedId(value);
        if (id) ids.add(id);
      });
    });

    return Array.from(ids);
  }

  function sanitizeAIStudioAttachmentError(error) {
    const message = error instanceof Error ? error.message : String(error || "");
    return message
      .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]")
      .replace(/\bya29\.[A-Za-z0-9._~-]+/g, "[redacted]")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240);
  }

  function summarizeAIStudioDriveFiles(
    fileIds,
    driveFiles,
    retrievalError,
    options = {}
  ) {
    const enabled = options.enabled !== false;
    const filesById = new Map(
      driveFiles
        .filter((file) => file && typeof file.id === "string")
        .map((file) => [file.id, file])
    );
    const expectedFiles = fileIds.map((id) => filesById.get(id) || null);
    const omittedReasons = new Set([
      "non_text",
      "too_large",
      "total_too_large",
    ]);

    return {
      filesById,
      stats: {
        enabled,
        inlinedTextCount: expectedFiles.filter(
          (file) => typeof file?.text === "string"
        ).length,
        metadataCount: expectedFiles.filter(
          (file) =>
            file &&
            !file.error &&
            (typeof file.name === "string" || typeof file.mimeType === "string")
        ).length,
        omittedCount: enabled
          ? expectedFiles.filter((file) =>
              omittedReasons.has(file?.omittedReason)
            ).length
          : fileIds.length,
        failedCount: enabled
          ? expectedFiles.filter(
              (file) =>
                !file ||
                Boolean(file.error) ||
                file.omittedReason === "unavailable"
            ).length
          : 0,
        error: enabled && retrievalError
          ? sanitizeAIStudioAttachmentError(retrievalError)
          : null,
      },
    };
  }

  function buildAIStudioStructuredData(prompt, options = {}) {
    const chatPayloads = getAIStudioChatPayloads(prompt);
    if (!chatPayloads.length) {
      throw new Error("AI Studio RPC prompt did not contain chat messages.");
    }

    // Normal chat prompts have one payload. For comparison prompts, preserve
    // every branch and label subsequent branches so no generated answer is lost.
    const structuredData = [];
    let domOrder = 0;
    let attachmentCount = 0;
    let earliestTimestamp = null;
    let latestTimestamp = null;

    const systemInstruction = getAIStudioJspbField(
      getAIStudioJspbField(prompt, 13),
      1
    );
    if (typeof systemInstruction === "string" && systemInstruction.trim()) {
      structuredData.push({
        domOrder: domOrder++,
        type: "system",
        systemText: systemInstruction.trim(),
        userText: null,
        thoughtText: null,
        responseText: null,
        images: [],
        videos: [],
      });
    }

    chatPayloads.forEach((chatPayload, branchIndex) => {
      const chunks = getAIStudioRepeatedMessages(
        getAIStudioJspbField(chatPayload, 1)
      );
      let current = null;

      chunks.forEach((chunk) => {
        const content = getAIStudioChunkContent(
          chunk,
          options.driveFilesById
        );
        if (
          !content.text &&
          !content.images.length &&
          !content.videos.length
        ) {
          return;
        }

        if (!current || current.type !== content.role) {
          current = {
            domOrder: domOrder++,
            type: content.role,
            userText: content.role === "user" ? "" : null,
            thoughtText: null,
            responseText: content.role === "model" ? "" : null,
            images: [],
            videos: [],
          };
          structuredData.push(current);
        }

        let text = content.text;
        if (
          branchIndex > 0 &&
          content.role === "model" &&
          !current.responseText &&
          !current.thoughtText
        ) {
          text = appendAIStudioText(
            `### Comparison branch ${branchIndex + 1}`,
            text
          );
        }

        if (content.role === "user") {
          current.userText = appendAIStudioText(current.userText, text);
        } else if (content.thought) {
          current.thoughtText = appendAIStudioText(current.thoughtText, text);
        } else {
          current.responseText = appendAIStudioText(current.responseText, text);
        }

        current.images.push(...content.images);
        current.videos.push(...content.videos);
        attachmentCount += content.attachmentCount;

        if (Number.isFinite(content.timestamp)) {
          earliestTimestamp =
            earliestTimestamp === null
              ? content.timestamp
              : Math.min(earliestTimestamp, content.timestamp);
          latestTimestamp =
            latestTimestamp === null
              ? content.timestamp
              : Math.max(latestTimestamp, content.timestamp);
        }
      });
    });

    const metadata = getAIStudioJspbField(prompt, 5);
    const conversationTitle = getAIStudioJspbField(metadata, 1);
    const promptName = getAIStudioJspbField(prompt, 1);
    const modelSettings = getAIStudioJspbField(prompt, 4);
    const apiModel = getAIStudioJspbField(modelSettings, 3);
    const conversationUuid =
      typeof promptName === "string" && promptName
        ? promptName.split("/").filter(Boolean).pop()
        : options.promptId || null;
    const userMessageCount = structuredData.filter(
      (item) => item.type === "user"
    ).length;
    const assistantMessageCount = structuredData.filter(
      (item) => item.type === "model"
    ).length;
    const thinkingMessageCount = structuredData.filter(
      (item) => item.type === "model" && item.thoughtText
    ).length;

    if (!userMessageCount && !assistantMessageCount) {
      throw new Error("AI Studio RPC prompt contained no exportable messages.");
    }

    return attachExportMeta(structuredData, {
      source: "Google AI Studio",
      model:
        typeof apiModel === "string" && apiModel
          ? apiModel.replace(/^models\//, "")
          : "Gemini",
      platform: "GOOGLE_AI_STUDIO",
      extractionMode: "aistudio_rpc",
      conversationUuid,
      conversationTitle:
        typeof conversationTitle === "string" && conversationTitle.trim()
          ? conversationTitle.trim()
          : null,
      apiModel: typeof apiModel === "string" ? apiModel : null,
      createdAtUtc: timestampToIso(earliestTimestamp),
      updatedAtUtc: timestampToIso(latestTimestamp),
      totalConversationMessageCount: userMessageCount + assistantMessageCount,
      exportedMessageCount: structuredData.length,
      userMessageCount,
      assistantMessageCount,
      thinkingMessageCount,
      attachmentCount,
      attachmentContentEnabled: options.attachmentStats?.enabled !== false,
      attachmentInlinedTextCount:
        options.attachmentStats?.inlinedTextCount || 0,
      attachmentMetadataCount: options.attachmentStats?.metadataCount || 0,
      attachmentOmittedCount: options.attachmentStats?.omittedCount || 0,
      attachmentFailedCount: options.attachmentStats?.failedCount || 0,
      attachmentRetrievalError: options.attachmentStats?.error || null,
      artifactCount: 0,
      researchTaskCount: 0,
      presentedFileCount: 0,
    });
  }

  async function fetchAIStudioDataFromRpc(options = {}) {
    const includeAttachments = options.includeAttachments !== false;
    const promptId = getAIStudioPromptIdFromUrl();
    if (!promptId) {
      throw new Error(
        "This AI Studio prompt has no saved Prompt ID yet. Save it first or use the page fallback."
      );
    }

    const rpcEntry = await requestAIStudioRpcCapture(promptId);
    const prompt = getAIStudioPromptArray(rpcEntry);
    const promptName = getAIStudioJspbField(prompt, 1);
    if (
      typeof promptName === "string" &&
      promptName &&
      !promptName.includes(promptId)
    ) {
      throw new Error("Captured AI Studio RPC belongs to a different prompt.");
    }

    const fileIds = collectAIStudioDriveFileIds(prompt);
    let driveFilesById = new Map();
    let driveFiles = [];
    let attachmentRetrievalError = null;

    if (fileIds.length && includeAttachments) {
      try {
        chrome.runtime.sendMessage({
          action: "UPDATE_STATUS",
          status: `Reading ${fileIds.length} AI Studio attachment${fileIds.length === 1 ? "" : "s"} in parallel...`,
        });
        driveFiles = await requestAIStudioDriveFiles(fileIds);
      } catch (error) {
        attachmentRetrievalError = error;
        console.info(
          "[AI Studio RPC] Attachment text unavailable; keeping file references:",
          error
        );
      }
    }

    const attachmentSummary = summarizeAIStudioDriveFiles(
      fileIds,
      driveFiles,
      attachmentRetrievalError,
      { enabled: includeAttachments }
    );
    driveFilesById = attachmentSummary.filesById;

    return buildAIStudioStructuredData(prompt, {
      promptId,
      driveFilesById,
      attachmentStats: attachmentSummary.stats,
    });
  }

  // Expose pure parser helpers only in explicit local test harnesses.
  if (globalThis.__PARODY_YOUR_AI_SCROLL_TEST__) {
    globalThis.__PARODY_AISTUDIO_RPC_TEST__ = {
      getJspbField: getAIStudioJspbField,
      getPromptArray: getAIStudioPromptArray,
      collectDriveFileIds: collectAIStudioDriveFileIds,
      summarizeDriveFiles: summarizeAIStudioDriveFiles,
      buildStructuredData: buildAIStudioStructuredData,
    };
  }

  // 5. Format Data
  function getSourceMetadata() {
    const href = window.location.href;
    if (href.includes("chatgpt.com") || href.includes("chat.openai.com")) {
      return { source: "ChatGPT", model: "GPT" };
    }
    if (href.includes("gemini.google.com")) {
      return { source: "Gemini", model: "Gemini" };
    }
    if (href.includes("claude.ai")) {
      return { source: "Claude", model: "Claude" };
    }
    if (href.includes("chat.qwen.ai")) {
      return { source: "Qwen", model: "Qwen" };
    }
    return { source: "Google AI Studio", model: "Gemini" };
  }

  function escapeYamlString(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function appendYamlField(lines, key, value) {
    if (value === null || value === undefined || value === "") return;
    if (typeof value === "number" || typeof value === "boolean") {
      lines.push(`${key}: ${value}`);
      return;
    }
    lines.push(`${key}: "${escapeYamlString(value)}"`);
  }

  function buildExportMetadataSummary(meta) {
    if (!meta || typeof meta !== "object") return "";

    const lines = ["## Export Metadata"];
    if (meta.platform) lines.push(`- Platform: \`${meta.platform}\``);
    if (meta.extractionMode) lines.push(`- Extraction: \`${meta.extractionMode}\``);
    if (meta.conversationUuid) {
      lines.push(`- Conversation UUID: \`${meta.conversationUuid}\``);
    }
    if (meta.apiModel) lines.push(`- API model: \`${meta.apiModel}\``);
    if (meta.createdAtUtc) lines.push(`- Created (UTC): \`${meta.createdAtUtc}\``);
    if (meta.updatedAtUtc) lines.push(`- Updated (UTC): \`${meta.updatedAtUtc}\``);
    if (typeof meta.exportedMessageCount === "number") {
      const total =
        typeof meta.totalConversationMessageCount === "number"
          ? meta.totalConversationMessageCount
          : meta.exportedMessageCount;
      lines.push(
        `- Exported messages: \`${meta.exportedMessageCount}\`${total !== meta.exportedMessageCount ? ` / total \`${total}\`` : ""}`
      );
    }
    if (typeof meta.userMessageCount === "number") {
      lines.push(`- User messages: \`${meta.userMessageCount}\``);
    }
    if (typeof meta.assistantMessageCount === "number") {
      lines.push(`- Assistant messages: \`${meta.assistantMessageCount}\``);
    }
    if (typeof meta.thinkingMessageCount === "number") {
      lines.push(`- Thinking-bearing messages: \`${meta.thinkingMessageCount}\``);
    }
    if (typeof meta.attachmentCount === "number" && meta.attachmentCount > 0) {
      lines.push(`- Referenced attachments: \`${meta.attachmentCount}\``);
    }
    if (typeof meta.attachmentContentEnabled === "boolean") {
      lines.push(
        `- Attachment text capture: \`${meta.attachmentContentEnabled === false ? "disabled" : "enabled"}\``
      );
    }
    if (typeof meta.citationCount === "number" && meta.citationCount > 0) {
      lines.push(`- Captured citations: \`${meta.citationCount}\``);
    }
    if (typeof meta.branchCount === "number" && meta.branchCount > 1) {
      lines.push(`- Detected response branches: \`${meta.branchCount}\``);
    }
    if (
      typeof meta.attachmentInlinedTextCount === "number" &&
      meta.attachmentCount > 0
    ) {
      lines.push(
        `- Inlined text attachments: \`${meta.attachmentInlinedTextCount}\``
      );
    }
    if (
      typeof meta.attachmentMetadataCount === "number" &&
      meta.attachmentMetadataCount > 0
    ) {
      lines.push(
        `- Resolved attachment metadata: \`${meta.attachmentMetadataCount}\``
      );
    }
    if (
      typeof meta.attachmentOmittedCount === "number" &&
      meta.attachmentOmittedCount > 0
    ) {
      lines.push(`- Intentionally omitted attachments: \`${meta.attachmentOmittedCount}\``);
    }
    if (
      typeof meta.attachmentFailedCount === "number" &&
      meta.attachmentFailedCount > 0
    ) {
      lines.push(`- Attachment retrieval failures: \`${meta.attachmentFailedCount}\``);
    }
    if (meta.attachmentRetrievalError) {
      lines.push(
        `- Attachment retrieval error: \`${String(meta.attachmentRetrievalError).replace(/`/g, "'")}\``
      );
    }
    if (typeof meta.artifactCount === "number" && meta.artifactCount > 0) {
      lines.push(`- Captured artifacts: \`${meta.artifactCount}\``);
    }
    if (typeof meta.presentedFileCount === "number" && meta.presentedFileCount > 0) {
      lines.push(`- Presented files: \`${meta.presentedFileCount}\``);
    }

    return `${lines.join("\n")}\n\n`;
  }

  function isEmbeddedDataUrl(url) {
    return typeof url === "string" && url.trim().toLowerCase().startsWith("data:");
  }

  function buildEmbeddedAssetPlaceholder(kind, label) {
    const trimmedLabel = typeof label === "string" ? label.trim() : "";
    if (!trimmedLabel) {
      return `[Embedded ${kind} omitted]`;
    }
    return `[Embedded ${kind} omitted: ${trimmedLabel}]`;
  }

  function sanitizeMarkdownForExport(markdown) {
    if (typeof markdown !== "string" || !markdown) return markdown;

    let sanitized = markdown.replace(
      /!\[([^\]]*)\]\((.+?)(\s+["'][^"']*["'])?\)/g,
      (match, alt, url) =>
        isEmbeddedDataUrl(url)
          ? buildEmbeddedAssetPlaceholder("image", alt)
          : match
    );

    sanitized = sanitized.replace(
      /\[([^\]]*)\]\((.+?)(\s+["'][^"']*["'])?\)/g,
      (match, text, url, title, offset, source) => {
        if (offset > 0 && source[offset - 1] === "!") {
          return match;
        }
        return isEmbeddedDataUrl(url)
          ? buildEmbeddedAssetPlaceholder("attachment", text)
          : match;
      }
    );

    return sanitized
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n");
  }

  function extractConversationIdFromPathname(pathname = location.pathname) {
    const segments = String(pathname || "")
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean);

    if (!segments.length) return null;

    const candidate = segments[segments.length - 1];
    return /^[a-z0-9][a-z0-9_-]{5,}$/i.test(candidate) ? candidate : null;
  }

  function getMessageThemeFallback(data) {
    if (!Array.isArray(data)) return "";

    for (const item of data) {
      const candidate = [item?.userText, item?.responseText]
        .find((value) => typeof value === "string" && value.trim());

      if (!candidate) continue;

      const preview = candidate.replace(/\s+/g, " ").trim();
      if (preview) {
        return preview.slice(0, 80);
      }
    }

    return "";
  }

  function getResolvedExportTitle(data, preferredTitle = "") {
    const preferred =
      typeof preferredTitle === "string" ? preferredTitle.trim() : "";
    if (preferred) return preferred;

    const exportMeta = getExportMeta(data);
    const metaTitle =
      typeof exportMeta?.conversationTitle === "string"
        ? exportMeta.conversationTitle.trim()
        : "";
    if (metaTitle) return metaTitle;

    const rawDocumentTitle =
      typeof document.title === "string" ? document.title.trim() : "";
    const cleanedDocumentTitle =
      typeof window.cleanExportTheme === "function"
        ? window.cleanExportTheme(rawDocumentTitle)
        : rawDocumentTitle;

    if (
      cleanedDocumentTitle &&
      !/^(ChatGPT|Claude|Gemini|Qwen|通义千问|Google Gemini|Google AI Studio|AI Chat Export)$/i.test(
        cleanedDocumentTitle
      )
    ) {
      return cleanedDocumentTitle;
    }

    return getMessageThemeFallback(data) || "AI Chat Export";
  }

  function buildExportFilenameForData(data, extension, options = {}) {
    if (typeof window.buildExportFilename !== "function") {
      return `export_${Date.now()}.${extension}`;
    }

    const exportMeta = getExportMeta(data);
    const sourceMeta = getSourceMetadata();
    const resolvedTitle = getResolvedExportTitle(data, options.title);
    const conversationId =
      options.conversationId ||
      exportMeta?.conversationUuid ||
      extractConversationIdFromPathname();
    const stableSeed = [
      conversationId,
      location.pathname,
      resolvedTitle,
      getMessageThemeFallback(data),
      Array.isArray(data) ? data.length : "",
      options.hashSeed,
    ]
      .filter(Boolean)
      .join("|");

    return window.buildExportFilename({
      platform: options.platform || exportMeta?.platform || exportMeta?.source || sourceMeta.source,
      theme: resolvedTitle,
      extension,
      conversationId,
      url: location.pathname,
      hashSeed: stableSeed,
    });
  }

  function formatData(data, format = "markdown") {
    const exportMeta = getExportMeta(data);
    const sorted =
      data ||
      Array.from(collectedData.values()).sort(
        (a, b) => a.domOrder - b.domOrder
      );

    if (format === "json") {
      if (exportMeta) {
        return JSON.stringify({ meta: exportMeta, messages: sorted }, null, 2);
      }
      return JSON.stringify(sorted, null, 2);
    }

    if (format === "html") {
      return generateHTML(sorted);
    }

    // Markdown with YAML Frontmatter
    const date = new Date().toISOString().split("T")[0];
    const pageTitle = getResolvedExportTitle(sorted);
    const baseMeta = getSourceMetadata();
    const meta = exportMeta
      ? {
          source: exportMeta.source || baseMeta.source,
          model: exportMeta.model || baseMeta.model,
        }
      : baseMeta;
    const yamlLines = [];
    appendYamlField(yamlLines, "title", pageTitle);
    yamlLines.push(`date: ${date}`);
    appendYamlField(yamlLines, "source", meta.source);
    appendYamlField(yamlLines, "model", meta.model);
    yamlLines.push("tags: [AI, Chat, Export]");

    if (exportMeta) {
      appendYamlField(yamlLines, "platform", exportMeta.platform);
      appendYamlField(yamlLines, "extraction_mode", exportMeta.extractionMode);
      appendYamlField(yamlLines, "conversation_uuid", exportMeta.conversationUuid);
      appendYamlField(yamlLines, "api_model", exportMeta.apiModel);
      appendYamlField(yamlLines, "created_at_utc", exportMeta.createdAtUtc);
      appendYamlField(yamlLines, "updated_at_utc", exportMeta.updatedAtUtc);
      appendYamlField(
        yamlLines,
        "current_leaf_message_uuid",
        exportMeta.currentLeafMessageUuid
      );
      appendYamlField(
        yamlLines,
        "total_message_count",
        exportMeta.totalConversationMessageCount
      );
      appendYamlField(yamlLines, "exported_message_count", exportMeta.exportedMessageCount);
      appendYamlField(yamlLines, "user_message_count", exportMeta.userMessageCount);
      appendYamlField(
        yamlLines,
        "assistant_message_count",
        exportMeta.assistantMessageCount
      );
      appendYamlField(
        yamlLines,
        "thinking_message_count",
        exportMeta.thinkingMessageCount
      );
      appendYamlField(yamlLines, "attachment_count", exportMeta.attachmentCount);
      appendYamlField(yamlLines, "citation_count", exportMeta.citationCount);
      appendYamlField(yamlLines, "branch_count", exportMeta.branchCount);
      appendYamlField(
        yamlLines,
        "attachment_content_enabled",
        exportMeta.attachmentContentEnabled
      );
      appendYamlField(
        yamlLines,
        "attachment_inlined_text_count",
        exportMeta.attachmentInlinedTextCount
      );
      appendYamlField(
        yamlLines,
        "attachment_metadata_count",
        exportMeta.attachmentMetadataCount
      );
      appendYamlField(
        yamlLines,
        "attachment_omitted_count",
        exportMeta.attachmentOmittedCount
      );
      appendYamlField(
        yamlLines,
        "attachment_failed_count",
        exportMeta.attachmentFailedCount
      );
      appendYamlField(
        yamlLines,
        "attachment_retrieval_error",
        exportMeta.attachmentRetrievalError
      );
      appendYamlField(yamlLines, "artifact_count", exportMeta.artifactCount);
      appendYamlField(
        yamlLines,
        "research_task_count",
        exportMeta.researchTaskCount
      );
      appendYamlField(
        yamlLines,
        "presented_file_count",
        exportMeta.presentedFileCount
      );
    }

    let md = `---\n${yamlLines.join("\n")}\n---\n\n# ${pageTitle}\n\n`;

    if (exportMeta) {
      md += buildExportMetadataSummary(exportMeta);
    }

    sorted.forEach((item) => {
      if (item.type === "system" && item.systemText) {
        md += `**System instruction**:\n${item.systemText}\n\n`;
      } else if (item.type === "user" && item.userText) {
        md += `**User**:\n${item.userText}\n\n`;
      } else if (item.type === "model") {
        if (item.thoughtText) {
          md += `> **Thinking**:\n> ${item.thoughtText.replace(
            /\n/g,
            "\n> "
          )}\n\n`;
        }
        if (item.responseText) {
          md += `**Model**:\n${item.responseText}\n\n`;
        }
      }
      md += "---\n\n";
    });
    return sanitizeMarkdownForExport(md);
  }

  // Helper to fetch resource as base64 with timeout and retry
  async function fetchAsBase64(url, retries = 2) {
    const MAX_SIZE_MB = 100; // Skip files larger than 100MB to avoid memory issues
    const TIMEOUT_MS = 30000; // 30 second timeout

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        console.log(
          `[Fetch] Attempt ${attempt + 1}/${retries + 1} for:`,
          url.substring(0, 100)
        );

        // Create abort controller for timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

        try {
          // Blob URLs must be fetched in the same context (content script), not background
          const response = await fetch(url, { signal: controller.signal });
          clearTimeout(timeoutId);

          if (!response.ok) {
            console.warn(
              `[Fetch] HTTP ${response.status} for ${url.substring(0, 100)}`
            );
            if (attempt < retries) {
              await delay(1000 * (attempt + 1)); // Progressive delay
              continue;
            }
            return null;
          }

          // Check size before downloading
          const contentLength = response.headers.get("content-length");
          if (contentLength) {
            const sizeMB = parseInt(contentLength) / (1024 * 1024);
            if (sizeMB > MAX_SIZE_MB) {
              console.warn(
                `[Fetch] File too large (${sizeMB.toFixed(2)}MB), skipping:`,
                url.substring(0, 100)
              );
              return null;
            }
            console.log(`[Fetch] Downloading ${sizeMB.toFixed(2)}MB...`);
          }

          const blob = await response.blob();
          const actualSizeMB = blob.size / (1024 * 1024);
          console.log(
            `[Fetch] Downloaded ${actualSizeMB.toFixed(
              2
            )}MB, converting to base64...`
          );

          // Convert blob to base64 using FileReader
          return new Promise((resolve) => {
            const reader = new FileReader();
            reader.onloadend = () => {
              console.log(`[Fetch] ✓ Successfully converted to base64`);
              resolve(reader.result); // This is already a data: URL
            };
            reader.onerror = () => {
              console.error(
                "[Fetch] ✗ FileReader error for:",
                url.substring(0, 100)
              );
              resolve(null);
            };
            reader.readAsDataURL(blob);
          });
        } catch (fetchError) {
          clearTimeout(timeoutId);
          throw fetchError;
        }
      } catch (error) {
        const isTimeout = error.name === "AbortError";
        console.warn(
          `[Fetch] ${isTimeout ? "Timeout" : "Error"} (attempt ${
            attempt + 1
          }):`,
          error.message
        );

        if (attempt < retries && !isTimeout) {
          await delay(1000 * (attempt + 1));
          continue;
        }

        // Final failure
        console.error(
          `[Fetch] ✗ Failed after ${attempt + 1} attempts:`,
          url.substring(0, 100)
        );
        return null;
      }
    }

    return null;
  }

  // HTML Generation with embedded media

  async function generateHTML(sortedData) {
    const title = document.title || "AI Chat Export";
    const date = new Date().toLocaleString();

    let content = "";

    for (const item of sortedData) {
      console.log(
        "Processing item:",
        item.type,
        "| Has images:",
        item.images?.length || 0,
        "| Has videos:",
        item.videos?.length || 0
      );

      // Outer turn wrapper
      content += `<div class="turn">`;
      content += `<div class="role-label">${
        item.type === "system"
          ? "System instruction"
          : item.type === "user"
            ? "User"
            : "Model"
      }</div>`;

      if (item.type === "user" || item.type === "system") {
        // User card with glass effect
        content += `<div class="user-card">`;

        // Add text content
        const sourceText =
          item.type === "system" ? item.systemText : item.userText;
        if (sourceText) {
          const textOnly = sourceText
            .split(/!\[|\[/)
            .filter((part, idx) => idx === 0)[0];
          if (textOnly.trim()) {
            content += escapeHtml(textOnly);
          }
        }

        // Add images from stored base64
        if (item.images && item.images.length > 0) {
          console.log("Adding", item.images.length, "images to HTML");
          content += '<div class="media-container">';
          item.images.forEach((img) => {
            content += `<img src="${img.base64}" alt="${escapeHtml(img.alt)}">`;
          });
          content += "</div>";
        }

        // Add videos from stored base64
        if (item.videos && item.videos.length > 0) {
          content += '<div class="media-container">';
          item.videos.forEach((vid) => {
            content += `<video controls><source src="${vid.base64}" type="video/mp4">Your browser does not support video.</video>`;
          });
          content += "</div>";
        }

        content += `</div>`; // Close user-card
      } else if (item.type === "model") {
        // Model card with IDE look
        content += `<div class="model-card">`;

        // macOS-style window header
        content += `<div class="model-header">`;
        content += `<div class="dot red"></div>`;
        content += `<div class="dot yellow"></div>`;
        content += `<div class="dot green"></div>`;
        content += `</div>`;

        // Model content
        content += `<div class="model-content">`;

        // Thinking section (if exists)
        if (item.thoughtText) {
          content += `<div class="thinking">`;
          content += `<div class="thinking-header" onclick="toggleThinking(this)">`;
          content += `<div class="thinking-title">Thinking</div>`;
          content += `<span class="arrow">↓</span>`;
          content += `</div>`;
          content += `<div class="thinking-content">`;
          content += escapeHtml(item.thoughtText);
          content += `</div>`;
          content += `</div>`;
        }

        // Response text
        if (item.responseText) {
          let textContent = item.responseText;
          // Simple markdown parsing for code blocks
          textContent = textContent.replace(
            /```(\w+)?\n([\s\S]*?)```/g,
            (match, lang, code) => {
              return `<pre><code class="language-${
                lang || "text"
              }">${escapeHtml(code)}</code></pre>`;
            }
          );
          // Bold
          textContent = textContent.replace(
            /\*\*(.*?)\*\*/g,
            "<strong>$1</strong>"
          );
          // Italic
          textContent = textContent.replace(/\*(.*?)\*/g, "<em>$1</em>");

          content += textContent;
        }

        if (item.images && item.images.length > 0) {
          content += '<div class="media-container">';
          item.images.forEach((img) => {
            content += `<img src="${img.base64}" alt="${escapeHtml(
              img.alt || "Generated image"
            )}">`;
          });
          content += "</div>";
        }

        if (item.videos && item.videos.length > 0) {
          content += '<div class="media-container">';
          item.videos.forEach((vid) => {
            content += `<video controls><source src="${vid.base64}" type="video/mp4">Your browser does not support video.</video>`;
          });
          content += "</div>";
        }

        content += `</div>`; // Close model-content
        content += `</div>`; // Close model-card
      }

      content += `</div>`; // Close turn
    }

    // Ensure getHTMLTemplate is available
    const templateFn =
      typeof getHTMLTemplate === "function"
        ? getHTMLTemplate
        : window.getHTMLTemplate;

    if (typeof templateFn !== "function") {
      throw new Error(
        "getHTMLTemplate function is not defined. Please reload the extension."
      );
    }

    return templateFn(title, date, content);
  }

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  async function embedImages(html) {
    const imgRegex = /<img[^>]+src="([^">]+)"/g;
    let match;
    let newHtml = html;
    const matches = [];

    while ((match = imgRegex.exec(html)) !== null) {
      matches.push({ full: match[0], url: match[1] });
    }

    for (const m of matches) {
      try {
        if (m.url.startsWith("data:")) continue;

        // Use background script to fetch image (CORS bypass)
        const base64Data = await new Promise((resolve) => {
          chrome.runtime.sendMessage(
            { action: "FETCH_RESOURCE", url: m.url },
            (response) => {
              if (response && response.success) {
                resolve(response.data);
              } else {
                console.warn(
                  "Failed to fetch image for embedding:",
                  m.url,
                  response?.error
                );
                resolve(null);
              }
            }
          );
        });

        if (base64Data) {
          newHtml = newHtml.replace(m.url, base64Data);
        }
      } catch (e) {
        console.error("Error embedding image:", e);
      }
    }
    return newHtml;
  }

  // ==========================================
  // 6. Smart Packaging (智能打包功能)
  // ==========================================

  // ==========================================
  // 6. Smart Packaging (智能打包功能)
  // ==========================================

  // JSZip is loaded globally via manifest.json

  // 6.2 正则常量

  // 6.2 正则常量
  const IMG_REGEX = /!\[([^\]]*)\]\((.+?)(\s+["'][^"']*["'])?\)/g;
  const LINK_REGEX = /\[([^\]]*)\]\((.+?)(\s+["'][^"']*["'])?\)/g;

  // Helper: MIME to Extension
  function getExtensionFromMime(mimeType) {
    const mimeMap = {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/gif": "gif",
      "image/webp": "webp",
      "image/svg+xml": "svg",
      "video/mp4": "mp4",
      "video/webm": "webm",
      "video/ogg": "ogv",
      "application/pdf": "pdf",
      "text/plain": "txt",
      "text/csv": "csv",
      "application/json": "json",
      "application/zip": "zip",
    };
    return mimeMap[mimeType] || mimeType.split("/")[1] || "bin";
  }

  // 6.3 收集图片 URL (返回 Map<Url, Filename>)
  function collectImageResources(markdown) {
    const resources = new Map();
    for (const match of markdown.matchAll(IMG_REGEX)) {
      const alt = match[1];
      const url = match[2];
      // Use alt text as filename hint if available
      resources.set(url, { filenameHint: alt });
    }
    return resources;
  }

  // 6.4 收集文件 URL (返回 Map<Url, Filename>)
  function collectFileResources(markdown) {
    const downloadableExtensions = [
      ".pdf",
      ".csv",
      ".txt",
      ".json",
      ".py",
      ".js",
      ".html",
      ".css",
      ".md",
      ".zip",
      ".mp4",
      ".webm",
    ];
    const resources = new Map();

    for (const match of markdown.matchAll(LINK_REGEX)) {
      if (match.index > 0 && markdown[match.index - 1] === "!") continue;

      const text = match[1];
      const url = match[2];
      const lowerUrl = url.toLowerCase();
      const isBlob = lowerUrl.startsWith("blob:");
      const isGoogleStorage =
        lowerUrl.includes("googlestorage") ||
        lowerUrl.includes("googleusercontent");
      const hasExt = downloadableExtensions.some((ext) =>
        lowerUrl.split("?")[0].endsWith(ext)
      );

      if (isBlob || isGoogleStorage || hasExt) {
        resources.set(url, { filenameHint: text });
      }
    }
    return resources;
  }

  // 6.5 通用资源处理器
  async function processResources(resourceMap, zipFolder, config, onProgress) {
    const urlToPathMap = new Map();
    if (resourceMap.size === 0) return urlToPathMap;

    let completedCount = 0;
    const urls = Array.from(resourceMap.keys());

    console.log(`[${config.type}] Processing ${urls.length} resources...`);

    const promises = urls.map(async (url, index) => {
      try {
        // Use background script for fetching to bypass CORS
        const blob = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage(
            { action: "FETCH_RESOURCE", url: url },
            (response) => {
              if (response && response.success) {
                fetch(response.data)
                  .then((res) => res.blob())
                  .then(resolve)
                  .catch(reject);
              } else {
                // Fallback to direct fetch if background fails (though background is preferred for CORS)
                fetch(url)
                  .then((res) => {
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    return res.blob();
                  })
                  .then(resolve)
                  .catch(reject);
              }
            }
          );
        });

        // Validate blob size

        // Validate blob size
        if (blob.size === 0) {
          console.error(`Downloaded empty blob for ${url}`);
          return;
        }
        if (blob.size < 100 && config.type === "image") {
          console.warn(
            `Suspicious small ${config.type} (${blob.size} bytes): ${url}`
          );
        }

        // Determine filename
        const info = resourceMap.get(url);
        let filename = info.filenameHint;

        // If filename is missing or invalid, generate one
        if (
          !filename ||
          filename.length > 50 ||
          /[^a-zA-Z0-9._\- ()]/.test(filename)
        ) {
          const ext = getExtensionFromMime(blob.type);
          // If it's an HTML file but we expected an image, skip it (likely a mistake)
          if (config.type === "image" && ext === "html") {
            console.warn("Skipping HTML file in image extraction:", url);
            return;
          }
          filename = `${config.prefix}_${index}.${ext}`;
        } else {
          // Ensure extension matches blob type if possible
          if (!filename.includes(".")) {
            filename += "." + getExtensionFromMime(blob.type);
          }
        }

        // Clean filename (remove invalid characters)
        filename = filename.replace(/[<>:"/\\|?*]/g, "_");

        console.log(
          `[${config.type}] Packaged: ${filename} (${blob.size} bytes, ${blob.type})`
        );

        zipFolder.file(filename, blob);
        urlToPathMap.set(url, `${config.subDir}/${filename}`);
      } catch (e) {
        console.error(`[${config.type}] Download failed for ${url}:`, e);
      }

      completedCount++;
      if (onProgress) onProgress(completedCount, urls.length);
    });

    await Promise.all(promises);
    console.log(
      `[${config.type}] Successfully packaged ${urlToPathMap.size}/${urls.length} resources`
    );
    return urlToPathMap;
  }

  // 6.6 主导出函数
  async function exportWithPackaging(markdown, mode = "text", exportInfo = {}) {
    console.log("exportWithPackaging called with mode:", mode);

    if (mode === "text") {
      const blob = new Blob([markdown], {
        type: "text/markdown;charset=utf-8",
      });
      downloadBlob(blob, exportInfo.filename || `export_${Date.now()}.md`);
      logToPopup("✓ Text file exported", "success");
      return;
    }

    // 完整打包模式
    try {
      // 尝试获取 JSZip (兼容不同的加载环境)
      const ZipLib =
        (typeof JSZip !== "undefined" ? JSZip : undefined) || window.JSZip;

      if (!ZipLib) {
        console.error(
          "JSZip not found. Global:",
          typeof JSZip,
          "Window:",
          typeof window.JSZip
        );
        throw new Error(
          "JSZip not loaded. Please go to chrome://extensions and reload this extension."
        );
      }

      logToPopup("Initializing packaging...");

      const zip = new ZipLib();
      const imgFolder = zip.folder("images");
      const fileFolder = zip.folder("files");

      // 收集资源
      const imgResources = collectImageResources(markdown);
      const fileResources = collectFileResources(markdown);

      logToPopup(
        `Found ${imgResources.size} images, ${fileResources.size} files`
      );
      console.log("Found resources:", {
        images: imgResources.size,
        files: fileResources.size,
      });

      // 下载图片
      if (imgResources.size > 0) {
        logToPopup(`Packaging ${imgResources.size} images...`);
        const imgMap = await processResources(
          imgResources,
          imgFolder,
          {
            subDir: "images",
            prefix: "image",
            type: "image",
          },
          (current, total) => {
            if (current % 5 === 0 || current === total) {
              logToPopup(`Packaging images: ${current}/${total}`);
            }
          }
        );

        // 替换图片链接
        markdown = markdown.replace(IMG_REGEX, (match, alt, url, title) => {
          if (imgMap.has(url)) {
            return `![${alt}](${imgMap.get(url)}${title || ""})`;
          }
          return match;
        });
      }

      // 下载文件
      if (fileResources.size > 0) {
        logToPopup(`Packaging ${fileResources.size} files...`);
        const fileMap = await processResources(
          fileResources,
          fileFolder,
          {
            subDir: "files",
            prefix: "file",
            type: "file",
          },
          (current, total) => {
            if (current % 5 === 0 || current === total) {
              logToPopup(`Packaging files: ${current}/${total}`);
            }
          }
        );

        // 替换文件链接
        markdown = markdown.replace(LINK_REGEX, (match, text, url, title) => {
          if (fileMap.has(url)) {
            return `[${text}](${fileMap.get(url)}${title || ""})`;
          }
          return match;
        });
      }

      // 生成 ZIP
      logToPopup("Generating ZIP file...");
      const zipFilename =
        exportInfo.filename || `export_${Date.now()}.zip`;
      const markdownFilename =
        exportInfo.markdownFilename ||
        zipFilename.replace(/\.zip$/i, ".md");
      zip.file(markdownFilename, markdown);
      const zipBlob = await zip.generateAsync({ type: "blob" });
      console.log("ZIP generated, size:", zipBlob.size);

      downloadBlob(zipBlob, zipFilename);

      logToPopup("✓ ZIP package exported", "success");
    } catch (error) {
      console.error("Packaging error:", error);
      logToPopup(`Packaging error: ${error.message}`, "error");
      throw error;
    }
  }

  // 6.7 下载 Blob 助手函数 (通过 Background 下载)
  function downloadBlob(blob, filename) {
    console.log("downloadBlob called:", filename, blob.size);

    const reader = new FileReader();
    reader.onload = async function () {
      const dataUrl = reader.result;

      // Check size. If small (< 10MB), send directly.
      if (dataUrl.length < 10 * 1024 * 1024) {
        chrome.runtime.sendMessage(
          {
            action: "DOWNLOAD_BLOB",
            url: dataUrl,
            filename: filename,
          },
          (response) => {
            if (chrome.runtime.lastError || (response && !response.success)) {
              logToPopup(
                "Download failed: " +
                  (chrome.runtime.lastError?.message || response?.error),
                "error"
              );
            }
          }
        );
        return;
      }

      // Chunked Transfer for large files
      const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB chunks
      const totalChunks = Math.ceil(dataUrl.length / CHUNK_SIZE);
      const fileId = Date.now().toString();

      logToPopup(`Transferring large file (${totalChunks} chunks)...`);

      for (let i = 0; i < totalChunks; i++) {
        const chunk = dataUrl.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        await new Promise((resolve) => {
          chrome.runtime.sendMessage(
            {
              action: "DOWNLOAD_CHUNK",
              fileId: fileId,
              chunk: chunk,
              index: i,
              total: totalChunks,
            },
            resolve
          );
        });
      }

      chrome.runtime.sendMessage(
        {
          action: "DOWNLOAD_FINISH",
          fileId: fileId,
          filename: filename,
        },
        (response) => {
          if (chrome.runtime.lastError || (response && !response.success)) {
            logToPopup(
              "Download failed: " +
                (chrome.runtime.lastError?.message || response?.error),
              "error"
            );
          } else {
            logToPopup("Download started!", "success");
          }
        }
      );
    };
    reader.onerror = function () {
      console.error("Failed to read blob");
      logToPopup("Failed to process file for download", "error");
    };
    reader.readAsDataURL(blob);
  }

  // Message Listener
  // --- ChatGPT Logic (API Based) ---

  const CHATGPT_API_MAPPING = {
    "https://chat.openai.com": "https://chat.openai.com/backend-api",
    "https://chatgpt.com": "https://chatgpt.com/backend-api",
    "https://new.oaifree.com": "https://new.oaifree.com/backend-api",
  };

  function getApiUrl() {
    const origin = new URL(location.href).origin;
    return CHATGPT_API_MAPPING[origin] || "https://chatgpt.com/backend-api";
  }

  function getChatIdFromUrl() {
    const match = location.pathname.match(
      /^\/(?:share|c|g\/[a-z0-9-]+\/c)\/([a-z0-9-]+)/i
    );
    if (match) return match[1];
    return null;
  }

  function isSharePage() {
    return /^\/share\/[a-z0-9-]+\/?$/i.test(location.pathname);
  }

  // Legacy fallback: may work in some Chrome contexts where page globals are visible.
  function getConversationFromSharePage() {
    const nextData = window.__NEXT_DATA__;
    const nextPayload = nextData?.props?.pageProps?.serverResponse?.data;
    if (nextPayload) {
      return JSON.parse(JSON.stringify(nextPayload));
    }

    const remixPayload =
      window.__remixContext?.state?.loaderData?.["routes/share.$shareId.($action)"]
        ?.serverResponse?.data;
    if (remixPayload) {
      return JSON.parse(JSON.stringify(remixPayload));
    }

    return null;
  }

  function getAccessToken() {
    return new Promise((resolve) => {
      const listener = (event) => {
        if (
          event.source === window &&
          event.data &&
          event.data.type === "CHATGPT_TOKEN_RESULT"
        ) {
          window.removeEventListener("message", listener);
          resolve(event.data.token);
        }
      };
      window.addEventListener("message", listener);

      // Request token from the MAIN world script (chatgpt_token.js)
      window.postMessage({ type: "CHATGPT_TOKEN_REQUEST" }, "*");

      // Timeout after 3 seconds
      setTimeout(() => {
        window.removeEventListener("message", listener);
        resolve(null);
      }, 3000);
    });
  }

  async function getAccessTokenFromSessionApi() {
    try {
      const response = await fetch("/api/auth/session", {
        method: "GET",
        credentials: "include",
        cache: "no-store",
      });
      if (!response.ok) return null;

      const session = await response.json();
      return session?.accessToken || null;
    } catch (e) {
      console.info("[ChatGPT Fetch] Session token fetch failed:", e);
      return null;
    }
  }

  function getConversationFromPageContext() {
    return new Promise((resolve) => {
      const listener = (event) => {
        if (
          event.source === window &&
          event.data &&
          event.data.type === "CHATGPT_CONVERSATION_RESULT"
        ) {
          window.removeEventListener("message", listener);
          resolve(event.data.conversation || null);
        }
      };
      window.addEventListener("message", listener);

      // Request conversation payload from MAIN world script (chatgpt_token.js)
      window.postMessage({ type: "CHATGPT_CONVERSATION_REQUEST" }, "*");

      setTimeout(() => {
        window.removeEventListener("message", listener);
        resolve(null);
      }, 3000);
    });
  }

  async function fetchConversation_ChatGPT(chatId, options = {}) {
    console.log(
      "[ChatGPT Fetch] Starting conversation fetch:",
      chatId,
      "| path:",
      location.pathname
    );

    // 1) Best effort: read already-loaded conversation from page runtime.
    if (!options.skipPageContext) {
      const pageConversation = await getConversationFromPageContext();
      if (pageConversation?.mapping) {
        console.log("[ChatGPT Fetch] Using page context conversation payload");
        return { id: chatId, ...pageConversation };
      }
    }

    // 2) Legacy fallback for share pages in case bridge fails.
    if (isSharePage() && !options.skipPageContext) {
      const shareConversation = getConversationFromSharePage();
      if (shareConversation?.mapping) {
        console.log("[ChatGPT Fetch] Using share fallback payload");
        return { id: chatId, ...shareConversation };
      }
      throw new Error(
        "Could not read share conversation data from page. Please refresh the page and try again."
      );
    }

    const apiUrl = getApiUrl();
    // 3) API fallback for normal /c/{id} pages.
    let accessToken = await getAccessToken();
    if (!accessToken) {
      accessToken = await getAccessTokenFromSessionApi();
    }

    if (!accessToken)
      throw new Error(
        "Could not find Access Token. Please refresh the page and try again."
      );

    const makeRequest = (token) =>
      fetch(`${apiUrl}/conversation/${chatId}`, {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      });

    let response = await makeRequest(accessToken);

    // Token may be stale. Retry once with fresh session token.
    if (
      !response.ok &&
      [401, 403, 404].includes(response.status)
    ) {
      const freshToken = await getAccessTokenFromSessionApi();
      if (freshToken && freshToken !== accessToken) {
        console.info(
          `[ChatGPT Fetch] Retrying with refreshed token after ${response.status}`
        );
        accessToken = freshToken;
        response = await makeRequest(accessToken);
      }
    }

    if (!response.ok) {
      // Final fallback: try page context once more before failing.
      if (!options.skipPageContext) {
        const fallbackConversation = await getConversationFromPageContext();
        if (fallbackConversation?.mapping) {
          console.info(
            `[ChatGPT Fetch] API ${response.status}, recovered via page context`
          );
          return { id: chatId, ...fallbackConversation };
        }
      }

      throw new Error(
        `Failed to fetch conversation: ${response.status} ${response.statusText}`
      );
    }

    return await response.json();
  }

  function normalizeRecentBatchLimit(value) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) return 10;
    return Math.min(parsed, 500);
  }

  function timestampToIso(value) {
    if (typeof value === "string" && value.trim()) {
      const parsed = Date.parse(value);
      return Number.isNaN(parsed) ? value.trim() : new Date(parsed).toISOString();
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      const ms = value > 100000000000 ? value : value * 1000;
      return new Date(ms).toISOString();
    }

    return null;
  }

  function getChatGPTConversationListItemId(item) {
    if (!item || typeof item !== "object") return null;

    const candidates = [
      item.id,
      item.conversation_id,
      item.conversationId,
      item.conversation?.id,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
    }

    return null;
  }

  function getChatGPTConversationListItemTitle(item) {
    if (!item || typeof item !== "object") return "";

    const candidates = [
      item.title,
      item.name,
      item.conversation?.title,
      item.conversation?.name,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
    }

    return "";
  }

  function getChatGPTConversationListItemTime(item, fieldType = "updated") {
    if (!item || typeof item !== "object") return null;

    const updatedCandidates = [
      item.update_time,
      item.updated_at,
      item.updatedAt,
      item.conversation?.update_time,
      item.conversation?.updated_at,
    ];
    const createdCandidates = [
      item.create_time,
      item.created_at,
      item.createdAt,
      item.conversation?.create_time,
      item.conversation?.created_at,
    ];
    const candidates =
      fieldType === "created" ? createdCandidates : updatedCandidates;

    for (const candidate of candidates) {
      const iso = timestampToIso(candidate);
      if (iso) return iso;
    }

    return null;
  }

  function normalizeChatGPTConversationListPayload(payload) {
    const candidateArrays = [];

    if (Array.isArray(payload)) candidateArrays.push(payload);

    if (payload && typeof payload === "object") {
      ["items", "data", "conversations", "results"].forEach((key) => {
        if (Array.isArray(payload[key])) candidateArrays.push(payload[key]);
      });
    }

    for (const candidateArray of candidateArrays) {
      const normalized = candidateArray
        .map((item) => {
          const id = getChatGPTConversationListItemId(item);
          if (!id) return null;

          const updatedAtUtc = getChatGPTConversationListItemTime(item, "updated");
          const createdAtUtc = getChatGPTConversationListItemTime(item, "created");
          const sortTime = Date.parse(updatedAtUtc || createdAtUtc || "") || 0;

          return {
            uuid: id,
            name: getChatGPTConversationListItemTitle(item),
            updatedAtUtc,
            createdAtUtc,
            sortTime,
          };
        })
        .filter(Boolean);

      if (normalized.length) {
        const byId = new Map();
        normalized.forEach((item) => {
          if (!byId.has(item.uuid)) byId.set(item.uuid, item);
        });
        return Array.from(byId.values()).sort((a, b) => b.sortTime - a.sortTime);
      }
    }

    return [];
  }

  function mergeConversationListItems(target, source) {
    const existing = new Set(target.map((item) => item.uuid));
    source.forEach((item) => {
      if (!item?.uuid || existing.has(item.uuid)) return;
      existing.add(item.uuid);
      target.push(item);
    });
  }

  async function fetchChatGPTConversationList(limit) {
    const normalizedLimit = normalizeRecentBatchLimit(limit);
    const apiUrl = getApiUrl();
    let accessToken = await getAccessToken();
    if (!accessToken) {
      accessToken = await getAccessTokenFromSessionApi();
    }

    if (!accessToken) {
      throw new Error(
        "Could not find ChatGPT access token. Please refresh and try again."
      );
    }

    const conversations = [];
    let lastError = null;
    const pageSize = 50;

    for (
      let offset = 0;
      conversations.length < normalizedLimit && offset < 500;
      offset += pageSize
    ) {
      const pageLimit = Math.min(pageSize, normalizedLimit - conversations.length);
      const query = new URLSearchParams({
        offset,
        limit: pageLimit,
        order: "updated",
      });

      try {
        const response = await fetch(`${apiUrl}/conversations?${query.toString()}`, {
          method: "GET",
          credentials: "include",
          cache: "no-store",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
        });

        if (!response.ok) {
          lastError = new Error(
            `Failed to fetch ChatGPT conversations: ${response.status} ${response.statusText}`
          );
          break;
        }

        const payload = await response.json();
        const pageConversations = normalizeChatGPTConversationListPayload(payload);
        mergeConversationListItems(conversations, pageConversations);

        const total = Number(payload?.total);
        const hasMore =
          payload?.has_more === true ||
          payload?.hasMore === true ||
          (Number.isFinite(total) && offset + pageConversations.length < total) ||
          (!Number.isFinite(total) && pageConversations.length >= pageLimit);

        if (!pageConversations.length || !hasMore) break;
      } catch (error) {
        lastError = error;
        break;
      }
    }

    if (conversations.length) {
      return conversations.slice(0, normalizedLimit);
    }

    const domConversations = extractChatGPTConversationListFromDOM(normalizedLimit);
    if (domConversations.length) {
      return domConversations;
    }

    throw lastError || new Error("Could not fetch ChatGPT conversations");
  }

  function extractChatGPTConversationListFromDOM(limit) {
    const normalizedLimit = normalizeRecentBatchLimit(limit);
    const conversations = [];
    const seen = new Set();
    const anchors = Array.from(
      document.querySelectorAll('a[href^="/c/"], a[href*="/c/"]')
    );

    anchors.forEach((anchor) => {
      const href = anchor.getAttribute("href") || "";
      const match = href.match(/\/c\/([a-z0-9-]+)/i);
      if (!match) return;

      const uuid = match[1].trim();
      if (!uuid || seen.has(uuid)) return;
      seen.add(uuid);

      const row = anchor.closest("li") || anchor.closest("[role='listitem']") || anchor;
      const titleCandidate =
        anchor.getAttribute("aria-label") ||
        row?.getAttribute?.("aria-label") ||
        anchor.textContent ||
        row?.textContent ||
        "";
      const name = String(titleCandidate || "")
        .replace(/\s+/g, " ")
        .trim();

      conversations.push({
        uuid,
        name,
        updatedAtUtc: null,
        createdAtUtc: null,
        sortTime: 0,
      });
    });

    return conversations.slice(0, normalizedLimit);
  }

  async function resolveImageAssets(conversation) {
    const mapping = conversation.mapping;
    const apiUrl = getApiUrl();
    let accessToken = await getAccessToken();
    if (!accessToken) {
      accessToken = await getAccessTokenFromSessionApi();
    }

    if (!accessToken) {
      return;
    }

    const imageAssets = [];
    Object.values(mapping).forEach((node) => {
      if (node.message && node.message.content) {
        const parts = node.message.content.parts || [];
        parts.forEach((part) => {
          if (
            part.content_type === "image_asset_pointer" &&
            part.asset_pointer &&
            part.asset_pointer.startsWith("file-service://")
          ) {
            imageAssets.push({ pointer: part.asset_pointer, part: part });
          }
        });
      }
    });

    for (const asset of imageAssets) {
      try {
        const fileId = asset.pointer.replace("file-service://", "");
        const downloadUrlRes = await fetch(
          `${apiUrl}/files/${fileId}/download`,
          {
            headers: { Authorization: `Bearer ${accessToken}` },
          }
        );

        if (downloadUrlRes.ok) {
          const downloadInfo = await downloadUrlRes.json();
          if (downloadInfo.download_url) {
            const b64 = await fetchAsBase64(downloadInfo.download_url);
            if (b64) {
              asset.part._base64 = b64;
            }
          }
        }
      } catch (e) {
        console.warn("Failed to resolve asset", asset.pointer, e);
      }
    }
  }

  function extractChatGPTDataFromDOM() {
    const records = [];
    const seen = new Set();

    const pushRecord = (node, roleCandidate = "") => {
      if (!node || seen.has(node)) return;
      seen.add(node);

      let role = String(roleCandidate || "").toLowerCase();
      if (role !== "user" && role !== "assistant") {
        const roleNode = node.closest?.("[data-message-author-role]");
        const attrRole = roleNode?.getAttribute?.("data-message-author-role");
        if (attrRole === "user" || attrRole === "assistant") {
          role = attrRole;
        }
      }

      if (role !== "user" && role !== "assistant") {
        const testId =
          node.getAttribute?.("data-testid") ||
          node.closest?.("[data-testid]")?.getAttribute?.("data-testid") ||
          "";
        if (/user/i.test(testId)) role = "user";
        if (/assistant|model/i.test(testId)) role = "assistant";
      }

      if (role !== "user" && role !== "assistant") return;
      records.push({ node, role });
    };

    // Legacy + still common selector.
    document.querySelectorAll("[data-message-author-role]").forEach((node) => {
      pushRecord(node, node.getAttribute("data-message-author-role") || "");
    });

    // Newer ChatGPT UIs often use conversation-turn testids.
    if (!records.length) {
      document
        .querySelectorAll(
          'article[data-testid^="conversation-turn-"], [data-testid^="conversation-turn-"]'
        )
        .forEach((turn) => {
          const testId = turn.getAttribute("data-testid") || "";
          let role = "";
          if (/user/i.test(testId)) role = "user";
          if (/assistant|model/i.test(testId)) role = "assistant";

          const contentNode =
            turn.querySelector("[data-message-content]") ||
            turn.querySelector(
              ".markdown, .prose, .text-message, .whitespace-pre-wrap"
            ) ||
            turn;

          pushRecord(contentNode, role);
        });
    }

    // Last-resort group-based extraction.
    if (!records.length) {
      document.querySelectorAll('div[class*="group"]').forEach((group) => {
        const userNode =
          group.querySelector('[data-message-author-role="user"]') || null;
        const assistantNode =
          group.querySelector('[data-message-author-role="assistant"]') || null;
        if (userNode) pushRecord(userNode, "user");
        if (assistantNode) pushRecord(assistantNode, "assistant");
      });
    }

    const structuredData = [];
    let domOrder = 0;

    for (const record of records) {
      const node = record.node;
      const role = record.role === "assistant" ? "model" : "user";
      const contentNode =
        node.querySelector?.("[data-message-content]") ||
        node.querySelector?.(".markdown, .prose, .text-message, .whitespace-pre-wrap") ||
        node;

      let text = (contentNode?.innerText || node.innerText || "").trim();
      text = text
        .replace(
          /\n(?:Copy|Edit|Read aloud|Good response|Bad response|Regenerate|Retry|Share)\s*$/gi,
          ""
        )
        .trim();

      const inlineImages = Array.from(node.querySelectorAll("img[src]"));
      inlineImages.forEach((img, idx) => {
        const src = img.getAttribute("src");
        if (!src) return;
        const alt = (img.getAttribute("alt") || `image_${idx + 1}`).trim();
        const imageReference = isEmbeddedDataUrl(src)
          ? buildEmbeddedAssetPlaceholder("image", alt)
          : `![${alt}](${src})`;
        if (!text.includes(imageReference)) {
          text += `${text ? "\n\n" : ""}${imageReference}`;
        }
      });

      if (!text) continue;

      structuredData.push({
        domOrder: domOrder++,
        type: role,
        userText: role === "user" ? text : null,
        thoughtText: null,
        responseText: role === "model" ? text : null,
        images: [],
        videos: [],
      });
    }

    const userMessageCount = structuredData.filter((item) => item.type === "user").length;
    const assistantMessageCount = structuredData.filter(
      (item) => item.type === "model"
    ).length;
    const exportMeta = {
      source: "ChatGPT",
      model: "ChatGPT",
      platform: "CHATGPT",
      extractionMode: "chatgpt_api",
      conversationUuid:
        typeof conversation?.id === "string"
          ? conversation.id
          : typeof conversation?.conversation_id === "string"
            ? conversation.conversation_id
            : null,
      conversationTitle:
        typeof conversation?.title === "string" ? conversation.title : null,
      createdAtUtc: timestampToIso(conversation?.create_time || conversation?.created_at),
      updatedAtUtc: timestampToIso(conversation?.update_time || conversation?.updated_at),
      totalConversationMessageCount: structuredData.length,
      exportedMessageCount: structuredData.length,
      userMessageCount,
      assistantMessageCount,
      thinkingMessageCount: 0,
      attachmentCount: structuredData.reduce(
        (count, item) => count + (Array.isArray(item.images) ? item.images.length : 0),
        0
      ),
      artifactCount: 0,
      researchTaskCount: 0,
      presentedFileCount: 0,
    };

    return attachExportMeta(structuredData, exportMeta);
  }

  async function processChatGPTData(conversation) {
    await resolveImageAssets(conversation);

    const mapping = conversation.mapping;
    let currentNodeId = conversation.current_node;
    const nodes = [];

    while (currentNodeId) {
      const node = mapping[currentNodeId];
      if (!node) break;

      if (
        node.message &&
        node.message.author.role !== "system" &&
        node.message.content.content_type !== "model_editable_context"
      ) {
        nodes.unshift(node);
      }

      currentNodeId = node.parent;
    }

    const structuredData = [];
    let domOrder = 0;

    for (const node of nodes) {
      const msg = node.message;
      const role = msg.author.role === "assistant" ? "model" : "user";

      let text = "";
      const images = [];

      const parts = msg.content.parts || [];
      for (const part of parts) {
        if (typeof part === "string") {
          text += part;
        } else if (part.content_type === "image_asset_pointer") {
          if (part._base64) {
            images.push({ base64: part._base64, alt: "Uploaded Image" });
          } else {
            text += ` [Image Asset: ${part.asset_pointer}] `;
          }
        } else if (part.content_type === "multimodal_text" && part.parts) {
          part.parts.forEach((sub) => {
            if (typeof sub === "string") text += sub;
          });
        }
      }

      const item = {
        domOrder: domOrder++,
        type: role,
        userText: role === "user" ? text : null,
        thoughtText: null,
        responseText: role === "model" ? text : null,
        images: images,
        videos: [],
      };

      structuredData.push(item);
    }

    return structuredData;
  }

  // --- Qwen Logic (authenticated history API, page bridge, DOM fallback) ---

  const QWEN_BRIDGE_REQUEST_TYPE = "QWEN_CHAT_DATA_REQUEST";
  const QWEN_BRIDGE_RESPONSE_TYPE = "QWEN_CHAT_DATA_RESULT";
  const QWEN_LIST_BRIDGE_REQUEST_TYPE = "QWEN_CHAT_LIST_REQUEST";
  const QWEN_LIST_BRIDGE_RESPONSE_TYPE = "QWEN_CHAT_LIST_RESULT";
  const QWEN_HISTORY_PAGE_LIMIT = 10;
  const QWEN_MAX_HISTORY_PAGES = 50;

  function getQwenExporter() {
    const exporter = globalThis.ParodyQwenExporter;
    if (!exporter) {
      throw new Error(
        "Qwen exporter module is unavailable. Reload the extension and refresh Qwen."
      );
    }
    return exporter;
  }

  function getQwenConversationIdFromUrl() {
    return getQwenExporter().getConversationId(location.pathname);
  }

  function buildQwenHistoryUrl(chatId, params = {}) {
    const search = new URLSearchParams();
    if (params.cursor) search.set("cursor", params.cursor);
    search.set("direction", params.direction || "up");
    search.set("limit", String(params.limit || QWEN_HISTORY_PAGE_LIMIT));
    return `/api/v2/chats/${encodeURIComponent(chatId)}?${search.toString()}`;
  }

  async function fetchQwenHistoryPageDirect(chatId, params = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    try {
      const url = buildQwenHistoryUrl(chatId, params);
      const response = await fetch(url, {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(
          `Qwen API ${response.status} ${response.statusText || ""}`.trim()
        );
      }
      const payload = await response.json();
      if (!payload || payload.success === false || !payload.data?.chat) {
        throw new Error("Qwen API returned no conversation history.");
      }
      return payload;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function fetchQwenConversationListPageDirect(page) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    try {
      const search = new URLSearchParams({
        page: String(page),
        exclude_project: "true",
      });
      const response = await fetch(`/api/v2/chats/?${search.toString()}`, {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        throw new Error(
          `Qwen chat list API ${response.status} ${response.statusText || ""}`.trim()
        );
      }
      const payload = await response.json();
      if (!payload || payload.success === false || !Array.isArray(payload.data)) {
        throw new Error("Qwen chat list API returned an invalid response.");
      }
      return payload;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function fetchQwenHistoryPageFromBridge(chatId, params = {}) {
    return new Promise((resolve, reject) => {
      const requestId = `qwen-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}`;
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        window.removeEventListener("message", onMessage);
        callback(value);
      };
      const onMessage = (event) => {
        if (
          event.source !== window ||
          event.data?.type !== QWEN_BRIDGE_RESPONSE_TYPE ||
          event.data?.requestId !== requestId
        ) {
          return;
        }
        if (!event.data.success) {
          finish(
            reject,
            new Error(event.data.error || "Qwen page bridge request failed.")
          );
          return;
        }
        try {
          const payload = JSON.parse(event.data.responseText);
          if (!payload || payload.success === false || !payload.data?.chat) {
            throw new Error("Qwen page bridge returned no conversation history.");
          }
          finish(resolve, payload);
        } catch (error) {
          finish(reject, error);
        }
      };
      const timeoutId = setTimeout(
        () =>
          finish(
            reject,
            new Error(
              "Qwen page bridge timed out. Refresh the Qwen page once and retry."
            )
          ),
        13000
      );

      window.addEventListener("message", onMessage);
      window.postMessage(
        {
          type: QWEN_BRIDGE_REQUEST_TYPE,
          requestId,
          chatId,
          cursor: params.cursor || null,
          direction: params.direction || "up",
          limit: params.limit || QWEN_HISTORY_PAGE_LIMIT,
        },
        "*"
      );
    });
  }

  function fetchQwenConversationListPageFromBridge(page) {
    return new Promise((resolve, reject) => {
      const requestId = `qwen-list-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}`;
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        window.removeEventListener("message", onMessage);
        callback(value);
      };
      const onMessage = (event) => {
        if (
          event.source !== window ||
          event.data?.type !== QWEN_LIST_BRIDGE_RESPONSE_TYPE ||
          event.data?.requestId !== requestId
        ) {
          return;
        }
        if (!event.data.success) {
          finish(
            reject,
            new Error(event.data.error || "Qwen chat-list bridge request failed.")
          );
          return;
        }
        try {
          const payload = JSON.parse(event.data.responseText);
          if (!payload || payload.success === false || !Array.isArray(payload.data)) {
            throw new Error("Qwen chat-list bridge returned an invalid response.");
          }
          finish(resolve, payload);
        } catch (error) {
          finish(reject, error);
        }
      };
      const timeoutId = setTimeout(
        () =>
          finish(
            reject,
            new Error(
              "Qwen chat-list bridge timed out. Refresh the Qwen page once and retry."
            )
          ),
        13000
      );

      window.addEventListener("message", onMessage);
      window.postMessage(
        {
          type: QWEN_LIST_BRIDGE_REQUEST_TYPE,
          requestId,
          page,
          exclude_project: true,
        },
        "*"
      );
    });
  }

  async function fetchQwenConversationListPage(page) {
    try {
      return await fetchQwenConversationListPageDirect(page);
    } catch (directError) {
      console.info(
        "[Qwen Batch] Direct chat-list request failed; trying page bridge:",
        directError
      );
      try {
        return await fetchQwenConversationListPageFromBridge(page);
      } catch (bridgeError) {
        throw new Error(
          `Direct list request: ${directError.message}; page bridge: ${bridgeError.message}`
        );
      }
    }
  }

  async function fetchQwenConversationList(limit) {
    const normalizedLimit = normalizeClaudeBatchLimit(limit);
    const conversations = [];
    const seen = new Set();

    for (let page = 1; page <= 100 && conversations.length < normalizedLimit; page++) {
      const payload = await fetchQwenConversationListPage(page);
      const items = Array.isArray(payload.data) ? payload.data : [];
      if (!items.length) break;

      let addedCount = 0;
      for (const item of items) {
        const uuid = String(item?.id || "").trim().toLowerCase();
        if (!UUID_PATTERN.test(uuid) || seen.has(uuid)) continue;
        seen.add(uuid);
        addedCount += 1;
        conversations.push({
          uuid,
          name:
            typeof item.title === "string" && item.title.trim()
              ? item.title.trim()
              : "Untitled Qwen conversation",
          updatedAtUtc: getQwenExporter().timestampToIso(item.updated_at),
          createdAtUtc: getQwenExporter().timestampToIso(item.created_at),
        });
        if (conversations.length >= normalizedLimit) break;
      }
      if (!addedCount) break;
    }

    return conversations.slice(0, normalizedLimit);
  }

  async function fetchQwenHistoryPage(chatId, params = {}) {
    try {
      return {
        payload: await fetchQwenHistoryPageDirect(chatId, params),
        extractionMode: "qwen_api",
      };
    } catch (directError) {
      console.info(
        "[Qwen Fetch] Direct history request failed; trying page bridge:",
        directError
      );
      try {
        return {
          payload: await fetchQwenHistoryPageFromBridge(chatId, params),
          extractionMode: "qwen_api_bridge",
        };
      } catch (bridgeError) {
        throw new Error(
          `Direct request: ${directError.message}; page bridge: ${bridgeError.message}`
        );
      }
    }
  }

  async function fetchQwenConversation(chatId) {
    const exporter = getQwenExporter();
    const initial = await fetchQwenHistoryPage(chatId, {
      direction: "up",
      limit: QWEN_HISTORY_PAGE_LIMIT,
    });
    const combinedPayload = initial.payload;
    let extractionMode = initial.extractionMode;
    let pagination = exporter.getPagination(combinedPayload);
    const seenCursors = new Set();
    let pageCount = 1;

    while (
      pagination?.enabled === true &&
      pagination.has_more_older === true &&
      pageCount < QWEN_MAX_HISTORY_PAGES
    ) {
      const cursor = String(pagination.oldest_id || "");
      if (!cursor || seenCursors.has(cursor)) {
        throw new Error("Qwen history pagination returned a repeated cursor.");
      }
      seenCursors.add(cursor);
      const page = await fetchQwenHistoryPage(chatId, {
        cursor,
        direction: "up",
        limit: QWEN_HISTORY_PAGE_LIMIT,
      });
      exporter.mergeConversationPayload(combinedPayload, page.payload);
      if (page.extractionMode === "qwen_api_bridge") {
        extractionMode = page.extractionMode;
      }
      pagination = exporter.getPagination(combinedPayload);
      pageCount += 1;
    }

    if (pagination?.enabled === true && pagination.has_more_older === true) {
      throw new Error(
        `Qwen history still has older messages after ${QWEN_MAX_HISTORY_PAGES} pages.`
      );
    }

    return { payload: combinedPayload, extractionMode };
  }

  async function hydrateQwenMedia(structuredData) {
    for (const item of structuredData) {
      const media = Array.isArray(item?.qwenMedia) ? item.qwenMedia : [];
      const seen = new Set();
      for (const reference of media) {
        if (!reference?.url || seen.has(reference.url)) continue;
        seen.add(reference.url);
        try {
          const base64 = await fetchAsBase64(reference.url, 1);
          if (!base64) continue;
          if (reference.kind === "video") {
            item.videos.push({
              base64,
              filename: reference.alt || "qwen-video.mp4",
            });
          } else if (reference.kind === "image") {
            item.images.push({
              base64,
              alt: reference.alt || "Qwen image",
            });
          }
        } catch (error) {
          console.info(
            "[Qwen Media] Keeping remote attachment after embed failure:",
            error
          );
        }
      }
    }
  }

  async function processQwenData(conversationData, options = {}) {
    const result = getQwenExporter().processConversation(
      conversationData.payload,
      {
        conversationId: options.conversationId,
        extractionMode:
          conversationData.extractionMode || options.extractionMode || "qwen_api",
      }
    );
    const structuredData = attachExportMeta(result.messages, result.meta);
    if (options.includeImageData) {
      await hydrateQwenMedia(structuredData);
    }
    return structuredData;
  }

  function extractQwenDataFromDOM() {
    const nodes = Array.from(
      document.querySelectorAll(
        ".qwen-chat-message-user, .qwen-chat-message-assistant"
      )
    );
    const messages = [];

    for (const node of nodes) {
      const isUser = node.classList?.contains("qwen-chat-message-user");
      const isAssistant = node.classList?.contains(
        "qwen-chat-message-assistant"
      );
      if (!isUser && !isAssistant) continue;
      const role = isUser ? "user" : "model";
      const contentNode = isUser
        ? node.querySelector(
            ".qwen-message-content-text, .chat-user-message-text-renderer-omni, .qwen-message-content"
          ) || node
        : node.querySelector(
            ".response-message-content .qwen-markdown, .qwen-markdown, .response-message-content"
          ) || node;
      let text = (contentNode.innerText || contentNode.textContent || "").trim();
      const thoughtNode = isAssistant
        ? node.querySelector(
            '[class*="thinking-summary"] .qwen-markdown, [class*="thinking"] [class*="summary"]'
          )
        : null;
      const thoughtText = (
        thoughtNode?.innerText || thoughtNode?.textContent || ""
      ).trim();
      const qwenMedia = [];

      node.querySelectorAll("img[src], video[src]").forEach((media, index) => {
        const src = media.currentSrc || media.getAttribute("src");
        if (!src || isEmbeddedDataUrl(src)) return;
        const kind = media.tagName === "VIDEO" ? "video" : "image";
        const alt = media.getAttribute("alt") || `Qwen ${kind} ${index + 1}`;
        qwenMedia.push({ kind, url: src, alt });
        const marker =
          kind === "image" ? `![${alt}](${src})` : `[${alt}](${src})`;
        if (!text.includes(marker)) {
          text += `${text ? "\n\n" : ""}${marker}`;
        }
      });

      if (!text && !thoughtText) continue;
      messages.push({
        domOrder: messages.length,
        type: role,
        userText: role === "user" ? text : null,
        thoughtText: role === "model" ? thoughtText || null : null,
        responseText: role === "model" ? text : null,
        images: [],
        videos: [],
        attachments: qwenMedia.map((item) => ({
          kind: item.kind,
          name: item.alt,
          url: item.url,
        })),
        citations: [],
        qwenMedia,
      });
    }

    if (!messages.length) return [];
    const chatId = getQwenConversationIdFromUrl();
    const userMessageCount = messages.filter(
      (message) => message.type === "user"
    ).length;
    const assistantMessageCount = messages.filter(
      (message) => message.type === "model"
    ).length;
    return attachExportMeta(messages, {
      source: "Qwen",
      model: "Qwen",
      platform: "QWEN",
      extractionMode: "qwen_dom",
      conversationUuid: chatId,
      conversationTitle:
        typeof document.title === "string"
          ? document.title
              .replace(/\s*[|-]\s*(?:Qwen|通义千问)\s*$/i, "")
              .trim()
          : null,
      createdAtUtc: null,
      updatedAtUtc: null,
      totalConversationMessageCount: messages.length,
      exportedMessageCount: messages.length,
      userMessageCount,
      assistantMessageCount,
      thinkingMessageCount: messages.filter((message) => message.thoughtText)
        .length,
      attachmentCount: messages.reduce(
        (count, message) => count + message.attachments.length,
        0
      ),
      citationCount: 0,
      branchCount: 1,
      artifactCount: 0,
      researchTaskCount: 0,
      presentedFileCount: 0,
    });
  }

  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const CLAUDE_ROOT_MESSAGE_UUID = "00000000-0000-4000-8000-000000000000";
  const CLAUDE_CONVERSATION_CACHE_TTL_MS = 15000;
  const CLAUDE_API_COOLDOWN_MS = 120000;
  const CLAUDE_BATCH_QUICK_LIMITS = new Set([10, 20, 50]);
  const CLAUDE_BATCH_DEFAULT_LIMIT = 10;
  const CLAUDE_BATCH_MIN_LIMIT = 1;
  const CLAUDE_BATCH_MAX_LIMIT = 500;
  const CLAUDE_BATCH_REQUEST_DELAY_MS = 150;
  let cachedClaudeOrganizationId = null;
  const cachedClaudeConversations = new Map();
  const cachedClaudeFileDownloads = new Map();
  let claudeApiDisabledUntil = 0;

  function isUuid(value) {
    return typeof value === "string" && UUID_PATTERN.test(value.trim());
  }

  function getClaudeChatIdFromUrl() {
    const match = location.pathname.match(/^\/chat\/([0-9a-f-]{36})\/?$/i);
    return match ? match[1] : null;
  }

  function getCookieValue(name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]*)`));
    if (!match) return null;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }

  function addClaudeOrgCandidate(candidateMap, value, score = 1) {
    if (!isUuid(value)) return;
    const normalized = value.trim().toLowerCase();
    candidateMap.set(normalized, (candidateMap.get(normalized) || 0) + score);
  }

  function collectClaudeOrgCandidatesFromText(text, candidateMap) {
    if (!text) return;

    const regexes = [
      { regex: /lastActiveOrg[^0-9a-f]{0,120}([0-9a-f-]{36})/gi, score: 8 },
      { regex: /organizationUUID[^0-9a-f]{0,120}([0-9a-f-]{36})/gi, score: 6 },
      { regex: /organizationId[^0-9a-f]{0,120}([0-9a-f-]{36})/gi, score: 5 },
      { regex: /memberships[^]{0,1500}?uuid[^0-9a-f]{0,60}([0-9a-f-]{36})/gi, score: 3 },
    ];

    for (const { regex, score } of regexes) {
      let match = null;
      while ((match = regex.exec(text)) !== null) {
        addClaudeOrgCandidate(candidateMap, match[1], score);
      }
    }
  }

  function pickBestClaudeOrgCandidate(candidateMap) {
    let bestId = null;
    let bestScore = -1;
    for (const [id, score] of candidateMap.entries()) {
      if (score > bestScore) {
        bestId = id;
        bestScore = score;
      }
    }
    return bestId;
  }

  function getClaudeOrganizationIdFromPage() {
    if (isUuid(cachedClaudeOrganizationId)) {
      return cachedClaudeOrganizationId.trim().toLowerCase();
    }

    const candidateMap = new Map();

    const cookieOrg = getCookieValue("lastActiveOrg");
    if (isUuid(cookieOrg)) {
      cachedClaudeOrganizationId = cookieOrg.trim().toLowerCase();
      return cachedClaudeOrganizationId;
    }

    addClaudeOrgCandidate(candidateMap, cookieOrg, 20);

    const scriptNodes = Array.from(document.querySelectorAll("script"));
    for (const script of scriptNodes) {
      const text = script.textContent || "";
      if (!text || text.length < 30) continue;
      if (!/organization|lastActiveOrg|memberships/i.test(text)) continue;
      collectClaudeOrgCandidatesFromText(text, candidateMap);
    }

    if (!candidateMap.size) {
      collectClaudeOrgCandidatesFromText(
        document.documentElement?.outerHTML || "",
        candidateMap
      );
    }

    const bestCandidate = pickBestClaudeOrgCandidate(candidateMap);
    if (isUuid(bestCandidate)) {
      cachedClaudeOrganizationId = bestCandidate.trim().toLowerCase();
    }

    return bestCandidate;
  }

  function hasClaudeConversationMessages(conversation) {
    return (
      conversation &&
      Array.isArray(conversation.chat_messages) &&
      conversation.chat_messages.length > 0
    );
  }

  function shouldPreferClaudeDomExtraction(targetFormat) {
    // Claude artifacts, thinking blocks, and tool metadata live in the
    // conversation API payload, not in the rendered DOM. Prefer the API for
    // every export format and keep DOM extraction as a fallback only.
    return false;
  }

  function markClaudeApiCoolingDown() {
    claudeApiDisabledUntil = Date.now() + CLAUDE_API_COOLDOWN_MS;
  }

  async function fetchConversation_Claude(orgId, chatId, options = {}) {
    const consistency = options.consistency || "default";
    const timeoutMs =
      typeof options.timeoutMs === "number" && options.timeoutMs > 0
        ? options.timeoutMs
        : 0;
    const cacheKey = `${orgId}:${chatId}:${consistency}`;
    const cachedEntry = cachedClaudeConversations.get(cacheKey);
    if (
      cachedEntry &&
      Date.now() - cachedEntry.timestamp < CLAUDE_CONVERSATION_CACHE_TTL_MS
    ) {
      return cachedEntry.data;
    }

    const query = new URLSearchParams({
      tree: "True",
      rendering_mode: "messages",
      render_all_tools: "true",
    });
    if (options.consistency) {
      query.set("consistency", options.consistency);
    }

    const controller = timeoutMs ? new AbortController() : null;
    const timeoutId = controller
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;

    try {
      const response = await fetch(
        `/api/organizations/${orgId}/chat_conversations/${chatId}?${query.toString()}`,
        {
          method: "GET",
          credentials: "include",
          cache: "no-store",
          signal: controller?.signal,
          headers: {
            Accept: "*/*",
            "Content-Type": "application/json",
          },
        }
      );

      if (!response.ok) {
        throw new Error(
          `Failed to fetch Claude conversation: ${response.status} ${response.statusText}`
        );
      }

      const data = await response.json();
      cachedClaudeConversations.set(cacheKey, {
        timestamp: Date.now(),
        data,
      });
      return data;
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error("Claude conversation request timed out");
      }
      throw error;
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  function getClaudeConversationListItemId(item) {
    if (!item || typeof item !== "object") return null;

    const candidates = [
      item.uuid,
      item.id,
      item.conversation_uuid,
      item.chat_conversation_uuid,
      item.chat_conversation?.uuid,
      item.conversation?.uuid,
    ];

    for (const candidate of candidates) {
      if (isUuid(candidate)) return candidate.trim().toLowerCase();
    }

    return null;
  }

  function getClaudeConversationListItemTitle(item) {
    if (!item || typeof item !== "object") return "";

    const candidates = [
      item.name,
      item.title,
      item.summary,
      item.chat_conversation?.name,
      item.conversation?.name,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
    }

    return "";
  }

  function getClaudeConversationListItemTime(item, fieldType = "updated") {
    if (!item || typeof item !== "object") return "";

    const updatedCandidates = [
      item.updated_at,
      item.last_activity_at,
      item.last_message_at,
      item.chat_conversation?.updated_at,
      item.conversation?.updated_at,
    ];
    const createdCandidates = [
      item.created_at,
      item.chat_conversation?.created_at,
      item.conversation?.created_at,
    ];
    const candidates =
      fieldType === "created" ? createdCandidates : updatedCandidates;

    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
    }

    return "";
  }

  function normalizeClaudeConversationListPayload(payload) {
    const candidateArrays = [];

    if (Array.isArray(payload)) {
      candidateArrays.push(payload);
    }

    const directKeys = [
      "chat_conversations",
      "conversations",
      "data",
      "items",
      "results",
    ];

    if (payload && typeof payload === "object") {
      directKeys.forEach((key) => {
        if (Array.isArray(payload[key])) {
          candidateArrays.push(payload[key]);
        }
      });

      Object.values(payload).forEach((value) => {
        if (Array.isArray(value)) {
          candidateArrays.push(value);
          return;
        }

        if (!value || typeof value !== "object") return;

        directKeys.forEach((key) => {
          if (Array.isArray(value[key])) {
            candidateArrays.push(value[key]);
          }
        });

        Object.values(value).forEach((nestedValue) => {
          if (Array.isArray(nestedValue)) {
            candidateArrays.push(nestedValue);
          }
        });
      });
    }

    if (candidateArrays.length > 1) {
      const seenArrays = new Set();
      for (let i = candidateArrays.length - 1; i >= 0; i--) {
        if (seenArrays.has(candidateArrays[i])) {
          candidateArrays.splice(i, 1);
        } else {
          seenArrays.add(candidateArrays[i]);
        }
      }
    }

    for (const candidateArray of candidateArrays) {
      const normalized = candidateArray
        .map((item) => {
          const uuid = getClaudeConversationListItemId(item);
          if (!uuid) return null;

          const updatedAtUtc = getClaudeConversationListItemTime(item, "updated");
          const createdAtUtc = getClaudeConversationListItemTime(item, "created");
          const sortTime =
            Date.parse(updatedAtUtc || createdAtUtc || "") || 0;

          return {
            uuid,
            name: getClaudeConversationListItemTitle(item),
            updatedAtUtc,
            createdAtUtc,
            sortTime,
          };
        })
        .filter(Boolean);

      if (normalized.length) {
        const byUuid = new Map();
        normalized.forEach((item) => {
          if (!byUuid.has(item.uuid)) byUuid.set(item.uuid, item);
        });
        return Array.from(byUuid.values()).sort(
          (a, b) => b.sortTime - a.sortTime
        );
      }
    }

    return [];
  }

  function getClaudeConversationListHasMore(payload) {
    if (!payload || typeof payload !== "object") return false;

    const candidates = [
      payload.has_more,
      payload.hasMore,
      payload.pagination?.has_more,
      payload.pagination?.hasMore,
      payload.meta?.has_more,
      payload.meta?.hasMore,
    ];

    return candidates.some((value) => value === true);
  }

  function mergeClaudeConversationListItems(target, source) {
    const existing = new Set(target.map((item) => item.uuid));

    source.forEach((item) => {
      if (!item?.uuid || existing.has(item.uuid)) return;
      existing.add(item.uuid);
      target.push(item);
    });
  }

  function extractClaudeConversationListFromDOM(limit) {
    const normalizedLimit = normalizeClaudeBatchLimit(limit);
    const conversations = [];
    const seen = new Set();
    const anchors = Array.from(document.querySelectorAll('a[href^="/chat/"]'));

    anchors.forEach((anchor) => {
      const href = anchor.getAttribute("href") || "";
      const match = href.match(/\/chat\/([0-9a-f-]{36})/i);
      if (!match || !isUuid(match[1])) return;

      const uuid = match[1].trim().toLowerCase();
      if (seen.has(uuid)) return;
      seen.add(uuid);

      const row = anchor.closest("tr") || anchor.closest("li") || anchor.parentElement;
      const timeNode = row?.querySelector?.("time[datetime]");
      const titleCandidate =
        anchor.getAttribute("aria-label") ||
        row?.querySelector?.("[aria-label]")?.getAttribute("aria-label") ||
        anchor.textContent ||
        row?.textContent ||
        "";
      const name = String(titleCandidate || "")
        .replace(/^Select\s+/i, "")
        .replace(/^More options for\s+/i, "")
        .replace(/\s+/g, " ")
        .trim();
      const updatedAtUtc =
        timeNode?.getAttribute("datetime") ||
        timeNode?.dateTime ||
        "";
      const sortTime = Date.parse(updatedAtUtc || "") || 0;

      conversations.push({
        uuid,
        name,
        updatedAtUtc,
        createdAtUtc: "",
        sortTime,
      });
    });

    return conversations
      .sort((a, b) => {
        if (a.sortTime || b.sortTime) return b.sortTime - a.sortTime;
        return 0;
      })
      .slice(0, normalizedLimit);
  }

  async function fetchClaudeConversationList(orgId, limit) {
    const normalizedLimit = normalizeClaudeBatchLimit(limit);
    const conversations = [];
    const endpointAttempts = [
      {
        path: "chat_conversations_v2",
        pageSize: 30,
        query: { consistency: "eventual" },
      },
      {
        path: "chat_conversations",
        pageSize: normalizedLimit,
        query: {},
      },
    ];
    let lastError = null;

    for (const endpointAttempt of endpointAttempts) {
      const endpoint = `/api/organizations/${orgId}/${endpointAttempt.path}`;
      conversations.length = 0;

      for (
        let offset = 0;
        conversations.length < normalizedLimit;
        offset += endpointAttempt.pageSize
      ) {
        const pageLimit = Math.min(
          endpointAttempt.pageSize,
          normalizedLimit - conversations.length
        );
        const query = new URLSearchParams({
          limit: pageLimit,
          offset,
          ...endpointAttempt.query,
        });

        try {
          const response = await fetch(`${endpoint}?${query.toString()}`, {
            method: "GET",
            credentials: "include",
            cache: "no-store",
            headers: {
              Accept: "*/*",
              "Content-Type": "application/json",
            },
          });

          if (!response.ok) {
            lastError = new Error(
              `Failed to fetch Claude conversations: ${response.status} ${response.statusText}`
            );
            break;
          }

          const payload = await response.json();
          const pageConversations = normalizeClaudeConversationListPayload(payload);
          mergeClaudeConversationListItems(conversations, pageConversations);

          if (!pageConversations.length || !getClaudeConversationListHasMore(payload)) {
            break;
          }
        } catch (error) {
          lastError = error;
          break;
        }
      }

      if (conversations.length) {
        return conversations.slice(0, normalizedLimit);
      }
    }

    const domConversations = extractClaudeConversationListFromDOM(normalizedLimit);
    if (domConversations.length) {
      return domConversations;
    }

    throw lastError || new Error("Could not fetch Claude conversations");
  }

  function compareClaudeMessages(a, b) {
    const idxA = typeof a.index === "number" ? a.index : Number.MAX_SAFE_INTEGER;
    const idxB = typeof b.index === "number" ? b.index : Number.MAX_SAFE_INTEGER;
    if (idxA !== idxB) return idxA - idxB;

    const timeA = Date.parse(a.created_at || a.updated_at || "") || 0;
    const timeB = Date.parse(b.created_at || b.updated_at || "") || 0;
    if (timeA !== timeB) return timeA - timeB;

    return 0;
  }

  function buildClaudeMessageChain(conversation) {
    const messages = Array.isArray(conversation?.chat_messages)
      ? conversation.chat_messages.filter((m) => m && typeof m === "object")
      : [];

    if (!messages.length) return [];

    const byUuid = new Map();
    messages.forEach((msg) => {
      if (isUuid(msg.uuid)) {
        byUuid.set(msg.uuid.toLowerCase(), msg);
      }
    });

    const currentLeaf =
      typeof conversation?.current_leaf_message_uuid === "string"
        ? conversation.current_leaf_message_uuid.toLowerCase()
        : null;

    if (currentLeaf && byUuid.has(currentLeaf)) {
      const chain = [];
      const seen = new Set();
      let cursor = currentLeaf;

      while (cursor && byUuid.has(cursor) && !seen.has(cursor)) {
        seen.add(cursor);
        const node = byUuid.get(cursor);
        chain.unshift(node);

        const parent =
          typeof node.parent_message_uuid === "string"
            ? node.parent_message_uuid.toLowerCase()
            : null;

        if (!parent || parent === CLAUDE_ROOT_MESSAGE_UUID) {
          break;
        }
        cursor = parent;
      }

      if (chain.length) return chain;
    }

    return messages.sort(compareClaudeMessages);
  }

  function attachExportMeta(data, meta) {
    if (!Array.isArray(data) || !meta || typeof meta !== "object") return data;
    Object.defineProperty(data, "exportMeta", {
      value: meta,
      writable: true,
      configurable: true,
      enumerable: false,
    });
    return data;
  }

  function getExportMeta(data) {
    if (!data || typeof data !== "object") return null;
    return data.exportMeta || null;
  }

  function buildClaudeConversationMetadata(conversation, messageChain) {
    const allMessages = Array.isArray(conversation?.chat_messages)
      ? conversation.chat_messages.filter((msg) => msg && typeof msg === "object")
      : [];
    const exportedChain = Array.isArray(messageChain) ? messageChain : [];

    let userMessageCount = 0;
    let assistantMessageCount = 0;
    let thinkingMessageCount = 0;
    let attachmentCount = 0;
    let artifactCount = 0;
    let researchTaskCount = 0;
    let presentedFileCount = 0;

    exportedChain.forEach((message) => {
      const sender = String(message?.sender || "").toLowerCase();
      if (sender === "human") userMessageCount += 1;
      if (sender === "assistant") assistantMessageCount += 1;

      const parts = Array.isArray(message?.content) ? message.content : [];
      if (
        parts.some(
          (part) =>
            part?.type === "thinking" &&
            typeof part.thinking === "string" &&
            part.thinking.trim()
        )
      ) {
        thinkingMessageCount += 1;
      }

      attachmentCount += collectClaudeFiles(message).length;

      parts.forEach((part) => {
        if (!part || typeof part !== "object") return;

        if (part.type === "tool_use" && part.name === "artifacts") {
          artifactCount += 1;
        }

        if (
          (part.type === "tool_use" || part.type === "tool_result") &&
          part.name === "launch_extended_search_task"
        ) {
          researchTaskCount += 1;
        }

        if (
          part.type === "tool_use" &&
          part.name === "present_files" &&
          Array.isArray(part?.input?.filepaths)
        ) {
          presentedFileCount += part.input.filepaths.length;
        }

        if (
          part.type === "tool_result" &&
          part.name === "present_files" &&
          Array.isArray(part.content)
        ) {
          presentedFileCount += part.content.filter(
            (item) => item && typeof item === "object" && item.type === "local_resource"
          ).length;
        }
      });
    });

    return {
      source: "Claude",
      model: "Claude",
      platform: String(conversation?.platform || "CLAUDE_AI"),
      extractionMode: "claude_api",
      conversationUuid:
        typeof conversation?.uuid === "string" ? conversation.uuid : null,
      conversationTitle:
        typeof conversation?.name === "string" ? conversation.name : null,
      apiModel:
        typeof conversation?.model === "string" ? conversation.model : null,
      createdAtUtc:
        typeof conversation?.created_at === "string" ? conversation.created_at : null,
      updatedAtUtc:
        typeof conversation?.updated_at === "string" ? conversation.updated_at : null,
      currentLeafMessageUuid:
        typeof conversation?.current_leaf_message_uuid === "string"
          ? conversation.current_leaf_message_uuid
          : null,
      totalConversationMessageCount: allMessages.length || exportedChain.length,
      exportedMessageCount: exportedChain.length,
      userMessageCount,
      assistantMessageCount,
      thinkingMessageCount,
      attachmentCount,
      artifactCount,
      researchTaskCount,
      presentedFileCount,
    };
  }

  function normalizeClaudeFileUrl(url) {
    if (!url || typeof url !== "string") return null;
    try {
      return new URL(url, window.location.origin).href;
    } catch {
      return null;
    }
  }

  function prefixClaudeArtifactLines(text, prefix) {
    return String(text || "")
      .split("\n")
      .map((line) => `${prefix}${line}`)
      .join("\n");
  }

  function normalizeMarkdownLinkTarget(target) {
    if (!target || typeof target !== "string") return null;
    const trimmed = target.trim();
    if (!trimmed) return null;

    try {
      if (/^https?:\/\//i.test(trimmed)) {
        return new URL(trimmed).href;
      }
    } catch {}

    return encodeURI(trimmed);
  }

  function formatMarkdownLink(label, target) {
    const normalizedTarget = normalizeMarkdownLinkTarget(target);
    if (!normalizedTarget) return label || "";
    return `[${label}](${normalizedTarget})`;
  }

  function getClaudeArtifactFenceLanguage(input) {
    const explicitLanguage =
      typeof input?.language === "string" ? input.language.trim() : "";
    if (explicitLanguage) return explicitLanguage;

    const type =
      typeof input?.type === "string" ? input.type.trim().toLowerCase() : "";
    const languageMap = {
      "application/json": "json",
      "text/html": "html",
      "text/css": "css",
      "text/javascript": "javascript",
      "application/javascript": "javascript",
      "text/typescript": "typescript",
      "image/svg+xml": "svg",
      "application/xml": "xml",
      "text/xml": "xml",
      "text/markdown": "markdown",
    };

    return languageMap[type] || "";
  }

  function formatClaudeToolOption(option) {
    if (typeof option === "string") return option.trim();
    if (!option || typeof option !== "object") return "";

    const label =
      typeof option.label === "string" && option.label.trim()
        ? option.label.trim()
        : "";
    const description =
      typeof option.description === "string" && option.description.trim()
        ? option.description.trim()
        : "";

    if (label && description) return `${label}: ${description}`;
    return label || description || "";
  }

  function summarizeClaudeAskUserInput(part) {
    const questions = Array.isArray(part?.input?.questions) ? part.input.questions : [];
    if (!questions.length) return null;

    const lines = ["### Prompted Questions"];
    questions.forEach((question, index) => {
      if (!question || typeof question !== "object") return;
      const prompt =
        typeof question.question === "string" && question.question.trim()
          ? question.question.trim()
          : `Question ${index + 1}`;
      lines.push(`Q: ${prompt}`);

      const options = Array.isArray(question.options) ? question.options : [];
      const formattedOptions = options
        .map((option) => formatClaudeToolOption(option))
        .filter(Boolean);

      if (formattedOptions.length) {
        formattedOptions.forEach((option) => {
          lines.push(`- ${option}`);
        });
      }
    });

    return lines.join("\n");
  }

  function summarizeClaudeExtendedSearchTask(part) {
    const command =
      typeof part?.input?.command === "string" ? part.input.command.trim() : "";
    if (!command) return null;

    return `### Research Task\n\`\`\`text\n${command}\n\`\`\``;
  }

  function extractClaudeToolResultText(part) {
    if (typeof part?.content === "string") {
      return part.content.trim();
    }

    if (!Array.isArray(part?.content)) return "";

    return part.content
      .map((item) => {
        if (typeof item === "string") return item.trim();
        if (!item || typeof item !== "object") return "";
        if (item.type === "text" && typeof item.text === "string") {
          return item.text.trim();
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  function summarizeClaudeInlineToolUse(part) {
    if (part?.type !== "tool_use") return null;

    if (part.name === "ask_user_input_v0") {
      return summarizeClaudeAskUserInput(part);
    }

    if (part.name === "launch_extended_search_task") {
      return summarizeClaudeExtendedSearchTask(part);
    }

    if (part.name === "present_files") {
      const filepaths = Array.isArray(part?.input?.filepaths) ? part.input.filepaths : [];
      if (!filepaths.length) return "### Presented Files";

      const lines = ["### Presented Files"];
      filepaths.forEach((filepath) => {
        if (typeof filepath !== "string" || !filepath.trim()) return;
        const trimmed = filepath.trim();
        const label = trimmed.split("/").pop() || trimmed;
        lines.push(`- ${formatMarkdownLink(label, trimmed)}`);
      });
      return lines.join("\n");
    }

    return null;
  }

  function summarizeClaudeInlineToolResult(part) {
    if (part?.type !== "tool_result") return null;

    if (part.name === "launch_extended_search_task") {
      const payloadText = extractClaudeToolResultText(part);
      if (!payloadText) return "### Research Task Result";

      try {
        const payload = JSON.parse(payloadText);
        if (payload && typeof payload === "object" && payload.task_id) {
          return `### Research Task Result\nTask ID: ${payload.task_id}`;
        }
      } catch {}

      return `### Research Task Result\n\`\`\`json\n${payloadText}\n\`\`\``;
    }

    return null;
  }

  function formatClaudeArtifactCitations(citations) {
    if (!Array.isArray(citations) || !citations.length) return "";

    const byUrl = new Map();

    citations.forEach((citation) => {
      if (!citation || typeof citation !== "object") return;

      const candidates = [];
      if (citation.url) {
        candidates.push({
          title:
            citation.title ||
            citation.metadata?.preview_title ||
            citation.metadata?.source ||
            citation.url,
          url: citation.url,
        });
      }

      if (Array.isArray(citation.sources)) {
        citation.sources.forEach((source) => {
          if (!source || typeof source !== "object" || !source.url) return;
          candidates.push({
            title:
              source.title ||
              source.source ||
              citation.title ||
              source.url,
            url: source.url,
          });
        });
      }

      candidates.forEach((candidate) => {
        const title = String(candidate.title || candidate.url || "").trim();
        const url = String(candidate.url || "").trim();
        if (!title || !url) return;

        const existing = byUrl.get(url);
        if (!existing) {
          byUrl.set(url, title);
          return;
        }

        const existingLooksGeneric = existing.toLowerCase() === url.toLowerCase();
        const titleLooksMoreSpecific = title.length > existing.length;
        if (existingLooksGeneric || titleLooksMoreSpecific) {
          byUrl.set(url, title);
        }
      });
    });

    const lines = Array.from(byUrl.entries()).map(
      ([url, title]) => `- [${title}](${url})`
    );

    if (!lines.length) return "";
    return `#### Sources (${lines.length})\n${lines.join("\n")}`;
  }

  function extractClaudeArtifact(part) {
    if (part?.type !== "tool_use" || part?.name !== "artifacts") {
      return null;
    }

    const input = part.input;
    if (!input || typeof input !== "object") return null;

    const title =
      typeof input.title === "string" && input.title.trim()
        ? input.title.trim()
        : "Untitled Artifact";
    const command =
      typeof input.command === "string" && input.command.trim()
        ? input.command.trim()
        : null;
    const type =
      typeof input.type === "string" && input.type.trim()
        ? input.type.trim()
        : null;
    const language =
      typeof input.language === "string" && input.language.trim()
        ? input.language.trim()
        : null;
    const content =
      typeof input.content === "string" && input.content.trim()
        ? input.content.trim()
        : null;
    const oldText =
      typeof input.old_str === "string" && input.old_str.trim()
        ? input.old_str.trim()
        : null;
    const newText =
      typeof input.new_str === "string" && input.new_str.trim()
        ? input.new_str.trim()
        : null;

    const headerBits = [command, type].filter(Boolean);
    const renderedParts = [`### Artifact: ${title}`];

    if (headerBits.length) {
      renderedParts.push(headerBits.join(" | "));
    }

    if (content) {
      if (!type || type === "text/markdown" || type === "text/plain") {
        renderedParts.push(content);
      } else {
        const fenceLanguage = getClaudeArtifactFenceLanguage(input);
        renderedParts.push(
          `\`\`\`${fenceLanguage}\n${content}\n\`\`\``
        );
      }
    } else if (oldText || newText) {
      const diffLines = [];
      if (oldText) diffLines.push(prefixClaudeArtifactLines(oldText, "- "));
      if (newText) diffLines.push(prefixClaudeArtifactLines(newText, "+ "));
      renderedParts.push(`\`\`\`diff\n${diffLines.join("\n")}\n\`\`\``);
    }

    const citationsText = formatClaudeArtifactCitations(input.md_citations);
    if (citationsText) {
      renderedParts.push(citationsText);
    }

    return {
      id:
        typeof input.id === "string" && input.id.trim() ? input.id.trim() : null,
      versionUuid:
        typeof input.version_uuid === "string" && input.version_uuid.trim()
          ? input.version_uuid.trim()
          : null,
      title,
      command,
      type,
      language,
      content,
      oldText,
      newText,
      citations: Array.isArray(input.md_citations) ? input.md_citations : [],
      text: renderedParts.filter(Boolean).join("\n\n"),
    };
  }

  function summarizeClaudeToolUse(part) {
    const name = part?.name || "tool";
    if (part?.input === undefined) {
      return `[Tool Use] ${name}`;
    }
    let inputText = "";
    try {
      inputText =
        typeof part.input === "string"
          ? part.input
          : JSON.stringify(part.input, null, 2);
    } catch {
      inputText = String(part.input);
    }
    if (!inputText.trim()) {
      return `[Tool Use] ${name}`;
    }
    return `[Tool Use] ${name}\n\`\`\`json\n${inputText}\n\`\`\``;
  }

  function summarizeClaudeToolResult(part) {
    const name = part?.name || "tool_result";
    const payload = part?.content;

    if (typeof payload === "string" && payload.trim()) {
      return `[Tool Result] ${name}\n${payload.trim()}`;
    }

    if (Array.isArray(payload) && payload.length) {
      const lines = [];
      payload.forEach((item) => {
        if (typeof item === "string") {
          if (item.trim()) lines.push(item.trim());
          return;
        }
        if (!item || typeof item !== "object") return;

        if (item.type === "text" && typeof item.text === "string") {
          if (item.text.trim()) lines.push(item.text.trim());
          return;
        }

        if (item.type === "knowledge" && item.url) {
          const title = item.title || item.url;
          lines.push(`- [${title}](${item.url})`);
          return;
        }

        if (item.type === "local_resource") {
          const target = item.file_path || item.url;
          const title = item.name || target;
          if (target && title) {
            lines.push(`- ${formatMarkdownLink(title, target)}`);
          }
          return;
        }

        if (item.url && item.title) {
          lines.push(`- [${item.title}](${item.url})`);
          return;
        }
      });

      if (lines.length) {
        return `[Tool Result] ${name}\n${lines.join("\n")}`;
      }
    }

    return `[Tool Result] ${name}`;
  }

  function collectClaudeFiles(message) {
    const files = [];
    const seen = new Set();
    const fileSources = [message.files, message.files_v2];

    fileSources.forEach((source) => {
      if (!Array.isArray(source)) return;
      source.forEach((file) => {
        if (!file || typeof file !== "object") return;
        const key =
          file.uuid ||
          file.file_uuid ||
          file.id ||
          file.preview_url ||
          file.path ||
          file.file_name ||
          JSON.stringify(file);
        if (seen.has(key)) return;
        seen.add(key);
        files.push(file);
      });
    });

    if (Array.isArray(message.attachments)) {
      message.attachments.forEach((attachment) => {
        if (!attachment || typeof attachment !== "object") return;
        const key = attachment.id || attachment.file_name || JSON.stringify(attachment);
        if (seen.has(key)) return;
        seen.add(key);
        files.push({
          ...attachment,
          file_kind: attachment.file_type || "attachment",
          preview_url: attachment.preview_url || attachment.url || null,
        });
      });
    }

    return files;
  }

  function collectClaudePresentedFiles(message) {
    const files = [];
    const seen = new Set();
    const parts = Array.isArray(message?.content) ? message.content : [];

    parts.forEach((part) => {
      if (!part || typeof part !== "object") return;

      if (part.type === "tool_use" && part.name === "present_files") {
        const filepaths = Array.isArray(part?.input?.filepaths) ? part.input.filepaths : [];
        filepaths.forEach((filepath) => {
          if (typeof filepath !== "string" || !filepath.trim()) return;
          const trimmed = filepath.trim();
          const key = `path:${trimmed}`;
          if (seen.has(key)) return;
          seen.add(key);
          files.push({
            name: trimmed.split("/").pop() || "attachment",
            target: trimmed,
          });
        });
        return;
      }

      if (part.type === "tool_result" && part.name === "present_files") {
        const items = Array.isArray(part.content) ? part.content : [];
        items.forEach((item) => {
          if (!item || typeof item !== "object") return;
          if (item.type !== "local_resource") return;
          const target =
            typeof item.file_path === "string" && item.file_path.trim()
              ? item.file_path.trim()
              : typeof item.url === "string" && item.url.trim()
                ? item.url.trim()
                : "";
          if (!target) return;
          const key = `resource:${target}`;
          if (seen.has(key)) return;
          seen.add(key);
          files.push({
            name: item.name || target.split("/").pop() || "attachment",
            target,
          });
        });
      }
    });

    return files;
  }

  function getClaudeAttachmentExtractedText(file) {
    const candidates = [
      file?.extracted_content,
      file?.extracted_text,
      file?.text_content,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
    }

    return null;
  }

  function isClaudeMarkdownAttachment(file, fileName = "") {
    const fileType = String(file?.file_type || file?.mime_type || "").toLowerCase();
    const normalizedFileName = String(fileName || "").toLowerCase();

    return (
      fileType === "text/markdown" ||
      fileType === "markdown" ||
      fileType === "md" ||
      normalizedFileName.endsWith(".md") ||
      normalizedFileName.endsWith(".markdown")
    );
  }

  function renderClaudeTextAttachment(fileName, extractedText, file) {
    const heading =
      fileName && fileName.toLowerCase() !== "attachment"
        ? `#### Attachment: ${fileName}`
        : "#### Attachment";

    if (isClaudeMarkdownAttachment(file, fileName)) {
      return `${heading}\n${extractedText}`;
    }

    return `${heading}\n\`\`\`text\n${extractedText}\n\`\`\``;
  }

  function isClaudeTextLikeFilename(fileName = "") {
    return /\.(txt|md|markdown|json|jsonl|csv|tsv|ya?ml|xml|html?|log|ini|cfg|conf|js|jsx|ts|tsx|py|go|java|c|cc|cpp|h|hpp|rs|sh|bash|zsh|sql)$/i.test(
      String(fileName || "").trim()
    );
  }

  async function fetchClaudeConversationFileText(filePath, options = {}) {
    const normalizedPath = typeof filePath === "string" ? filePath.trim() : "";
    const conversationUuid =
      typeof options.conversationUuid === "string" ? options.conversationUuid.trim() : "";
    const organizationId =
      typeof options.organizationId === "string" ? options.organizationId.trim() : "";

    if (!normalizedPath || !isUuid(conversationUuid) || !isUuid(organizationId)) {
      return null;
    }

    const cacheKey = `${organizationId}:${conversationUuid}:${normalizedPath}`;
    if (cachedClaudeFileDownloads.has(cacheKey)) {
      return cachedClaudeFileDownloads.get(cacheKey);
    }

    const downloadPromise = (async () => {
      try {
        const response = await fetch(
          `/api/organizations/${organizationId}/conversations/${conversationUuid}/wiggle/download-file?path=${encodeURIComponent(
            normalizedPath
          )}`,
          {
            method: "GET",
            credentials: "include",
            cache: "no-store",
          }
        );

        if (!response.ok) {
          return null;
        }

        const text = await response.text();
        return typeof text === "string" && text.trim() ? text.trim() : null;
      } catch {
        return null;
      }
    })();

    cachedClaudeFileDownloads.set(cacheKey, downloadPromise);
    return downloadPromise;
  }

  async function processClaudeFileAttachments(message, textParts, options = {}) {
    const includeImageData = options.includeImageData === true;
    const imageFetchTasks = [];
    const files = collectClaudeFiles(message);

    for (const file of files) {
      const fileName = (
        file.file_name ||
        file.name ||
        (typeof file.path === "string" ? file.path.split("/").pop() : "") ||
        "attachment"
      ).trim();
      const fileKind = String(file.file_kind || file.file_type || "").toLowerCase();
      const previewCandidate =
        file.preview_url ||
        file.preview_asset?.url ||
        file.thumbnail_url ||
        file.thumbnail_asset?.url ||
        file.url;
      const fileUrl = normalizeClaudeFileUrl(previewCandidate);
      const isImage =
        fileKind.includes("image") ||
        /\.(png|jpe?g|gif|webp|svg)$/i.test(fileName);
      let extractedText = getClaudeAttachmentExtractedText(file);

      if (isImage && fileUrl) {
        if (includeImageData) {
          imageFetchTasks.push(
            fetchAsBase64(fileUrl).then((base64) =>
              base64 ? { alt: fileName, base64 } : null
            )
          );
        }
        if (!textParts.some((line) => line.includes(fileUrl))) {
          textParts.push(`![${fileName}](${fileUrl})`);
        }
        continue;
      }

      if (
        !extractedText &&
        typeof file.path === "string" &&
        file.path.trim() &&
        isClaudeTextLikeFilename(fileName)
      ) {
        extractedText = await fetchClaudeConversationFileText(file.path.trim(), options);
      }

      if (extractedText) {
        const renderedAttachment = renderClaudeTextAttachment(
          fileName,
          extractedText,
          file
        );
        if (!textParts.includes(renderedAttachment)) {
          textParts.push(renderedAttachment);
        }
        continue;
      }

      if (fileUrl) {
        if (!textParts.some((line) => line.includes(fileUrl))) {
          textParts.push(formatMarkdownLink(fileName, fileUrl));
        }
      } else if (typeof file.path === "string" && file.path.trim()) {
        const attachmentLink = formatMarkdownLink(
          `Attachment: ${fileName}`,
          file.path.trim()
        );
        if (attachmentLink) {
          textParts.push(attachmentLink);
        }
      } else if (fileName) {
        textParts.push(`[Attachment: ${fileName}]`);
      }
    }

    if (!includeImageData || !imageFetchTasks.length) {
      return [];
    }

    const images = await Promise.all(imageFetchTasks);
    return images.filter(Boolean);
  }

  async function processClaudeData(conversation, options = {}) {
    const structuredData = [];
    let domOrder = 0;
    const messageChain = buildClaudeMessageChain(conversation);
    const exportMeta = buildClaudeConversationMetadata(conversation, messageChain);
    const claudeAttachmentOptions = {
      ...options,
      conversationUuid:
        typeof conversation?.uuid === "string" ? conversation.uuid : null,
      organizationId: getClaudeOrganizationIdFromPage(),
    };

    for (const message of messageChain) {
      const sender = typeof message.sender === "string" ? message.sender.toLowerCase() : "";
      if (sender !== "human" && sender !== "assistant") continue;

      const textParts = [];
      const thinkingParts = [];
      const toolParts = [];
      const artifactParts = [];
      const artifacts = [];
      const contentParts = Array.isArray(message.content) ? message.content : [];

      for (const part of contentParts) {
        if (!part || typeof part !== "object") continue;

        if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
          textParts.push(part.text.trim());
          continue;
        }

        if (
          part.type === "thinking" &&
          typeof part.thinking === "string" &&
          part.thinking.trim()
        ) {
          thinkingParts.push(part.thinking.trim());
          continue;
        }

        if (part.type === "tool_use") {
          const artifact = extractClaudeArtifact(part);
          if (artifact) {
            artifacts.push(artifact);
            if (artifact.text) artifactParts.push(artifact.text);
            continue;
          }
          const inlineToolSummary = summarizeClaudeInlineToolUse(part);
          if (inlineToolSummary) {
            textParts.push(inlineToolSummary);
            continue;
          }
          toolParts.push(summarizeClaudeToolUse(part));
          continue;
        }

        if (part.type === "tool_result") {
          const inlineToolResult = summarizeClaudeInlineToolResult(part);
          if (inlineToolResult) {
            textParts.push(inlineToolResult);
            continue;
          }
          toolParts.push(summarizeClaudeToolResult(part));
        }
      }

      if (artifactParts.length) {
        textParts.push(...artifactParts);
      }

      const presentedFiles = collectClaudePresentedFiles(message);
      presentedFiles.forEach((file) => {
        if (!file || !file.target) return;
        if (textParts.some((line) => line.includes(file.target))) return;
        const link = formatMarkdownLink(file.name || "attachment", file.target);
        if (link) textParts.push(link);
      });

      if (!textParts.length && typeof message.text === "string" && message.text.trim()) {
        textParts.push(message.text.trim());
      }

      if (!textParts.length && toolParts.length) {
        textParts.push(...toolParts);
      }

      const images = await processClaudeFileAttachments(
        message,
        textParts,
        claudeAttachmentOptions
      );
      const text = textParts.join("\n\n").trim();
      const thoughtText = thinkingParts.join("\n\n").trim();

      if (!text && !thoughtText && !images.length) continue;

      structuredData.push({
        domOrder: domOrder++,
        type: sender === "assistant" ? "model" : "user",
        userText: sender === "human" ? text : null,
        thoughtText: sender === "assistant" ? thoughtText || null : null,
        responseText: sender === "assistant" ? text || null : null,
        artifacts: sender === "assistant" ? artifacts : [],
        images: images,
        videos: [],
      });
    }

    return attachExportMeta(structuredData, exportMeta);
  }

  function extractClaudeDataFromDOM() {
    const messageNodes = Array.from(
      document.querySelectorAll(
        "div.font-user-message, div[data-is-streaming], [data-testid='chat-message-user'], [data-testid='chat-message-assistant']"
      )
    );

    const structuredData = [];
    let domOrder = 0;

    for (const node of messageNodes) {
      let text = (node.innerText || "").trim();
      if (!text) continue;

      text = text
        .replace(/\n(?:Copy|Retry|Edit|Good response|Bad response)\s*$/gi, "")
        .trim();

      if (!text) continue;

      const isUser =
        node.classList.contains("font-user-message") ||
        node.getAttribute("data-testid") === "chat-message-user" ||
        !!node.closest("[data-testid='chat-message-user']");
      const role = isUser ? "user" : "model";

      structuredData.push({
        domOrder: domOrder++,
        type: role,
        userText: role === "user" ? text : null,
        thoughtText: null,
        responseText: role === "model" ? text : null,
        images: [],
        videos: [],
      });
    }

    return structuredData;
  }

  function normalizeClaudeBatchLimit(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return CLAUDE_BATCH_DEFAULT_LIMIT;

    const integerValue = Math.floor(parsed);
    if (CLAUDE_BATCH_QUICK_LIMITS.has(integerValue)) return integerValue;

    return Math.min(
      CLAUDE_BATCH_MAX_LIMIT,
      Math.max(CLAUDE_BATCH_MIN_LIMIT, integerValue)
    );
  }

  function normalizeClaudeBatchFormat(value) {
    const raw = String(value || "markdown").toLowerCase();
    return ["markdown", "json", "html", "text", "zip"].includes(raw)
      ? raw
      : "markdown";
  }

  function getClaudeBatchContentFormat(format) {
    return format === "zip" ? "markdown" : format;
  }

  function getClaudeBatchContentExtension(format) {
    if (format === "json") return "json";
    if (format === "html") return "html";
    if (format === "text") return "txt";
    return "md";
  }

  function sanitizeClaudeZipEntryName(filename, fallback = "export.md") {
    const sanitized = String(filename || "")
      .replace(/[\\/]+/g, "-")
      .replace(/[\u0000-\u001f]+/g, "")
      .replace(/^\.+/, "")
      .trim();

    return sanitized || fallback;
  }

  function buildClaudeBatchEntryName(usedNames, index, filename) {
    const paddedIndex = String(index + 1).padStart(2, "0");
    const safeFilename = sanitizeClaudeZipEntryName(filename);
    const dotIndex = safeFilename.lastIndexOf(".");
    const base =
      dotIndex > 0 ? safeFilename.slice(0, dotIndex) : safeFilename;
    const extension =
      dotIndex > 0 ? safeFilename.slice(dotIndex) : "";
    let candidate = `${paddedIndex}-${safeFilename}`;
    let suffix = 2;

    while (usedNames.has(candidate)) {
      candidate = `${paddedIndex}-${base}-${suffix}${extension}`;
      suffix += 1;
    }

    usedNames.add(candidate);
    return candidate;
  }

  function formatStructuredDataAsText(structuredData) {
    const title = getResolvedExportTitle(structuredData);
    const lines = [title, "=".repeat(title.length), ""];

    structuredData.forEach((item) => {
      if (item.type === "user" && item.userText) {
        lines.push("User:", item.userText, "");
      } else if (item.type === "model") {
        if (item.thoughtText) {
          lines.push("Thinking:", item.thoughtText, "");
        }
        if (item.responseText) {
          lines.push("Model:", item.responseText, "");
        }
      }
      lines.push("-".repeat(20), "");
    });

    return lines.join("\n");
  }

  async function formatClaudeBatchConversation(structuredData, format) {
    if (format === "html") {
      return await generateHTML(structuredData);
    }

    if (format === "json") {
      return formatData(structuredData, "json");
    }

    if (format === "text") {
      return formatStructuredDataAsText(structuredData);
    }

    return formatData(structuredData, "markdown");
  }

  function buildClaudeBatchZipFilename(limit, exportedCount, conversations) {
    const count = exportedCount || limit;
    const ids = Array.isArray(conversations)
      ? conversations.map((item) => item.uuid).filter(Boolean)
      : [];

    if (typeof window.buildExportFilename === "function") {
      return window.buildExportFilename({
        platform: "Claude",
        theme: `recent-${count}-conversations`,
        extension: "zip",
        hashSeed: ids.join("|") || `${limit}|${Date.now()}`,
      });
    }

    const date = new Date().toISOString().slice(0, 10);
    return `claude-recent-${count}-conversations-${date}.zip`;
  }

  function getClaudeConversationListLabel(conversation) {
    const title =
      typeof conversation?.name === "string" && conversation.name.trim()
        ? conversation.name.trim()
        : conversation?.uuid || "Untitled Claude conversation";

    return title.length > 54 ? `${title.slice(0, 51)}...` : title;
  }

  function getChatGPTConversationListLabel(conversation) {
    const title =
      typeof conversation?.name === "string" && conversation.name.trim()
        ? conversation.name.trim()
        : conversation?.uuid || "Untitled ChatGPT conversation";

    return title.length > 54 ? `${title.slice(0, 51)}...` : title;
  }

  function buildChatGPTBatchZipFilename(limit, exportedCount, conversations) {
    const count = exportedCount || limit;
    const ids = Array.isArray(conversations)
      ? conversations.map((item) => item.uuid).filter(Boolean)
      : [];

    if (typeof window.buildExportFilename === "function") {
      return window.buildExportFilename({
        platform: "ChatGPT",
        theme: `recent-${count}-conversations`,
        extension: "zip",
        hashSeed: ids.join("|") || `${limit}|${Date.now()}`,
      });
    }

    const date = new Date().toISOString().slice(0, 10);
    return `chatgpt-recent-${count}-conversations-${date}.zip`;
  }

  async function exportChatGPTRecentConversations(request = {}) {
    const limit = normalizeRecentBatchLimit(request.limit);
    const requestedFormat = normalizeClaudeBatchFormat(request.format);
    const contentFormat = getClaudeBatchContentFormat(requestedFormat);
    const extension = getClaudeBatchContentExtension(contentFormat);

    const ZipLib =
      (typeof JSZip !== "undefined" ? JSZip : undefined) || window.JSZip;
    if (!ZipLib) {
      throw new Error(
        "JSZip not loaded. Please go to chrome://extensions and reload this extension."
      );
    }

    logToPopup(`Fetching recent ${limit} ChatGPT conversations...`);
    const conversations = await fetchChatGPTConversationList(limit);
    if (!conversations.length) {
      throw new Error("ChatGPT returned no recent conversations.");
    }

    const zip = new ZipLib();
    const usedNames = new Set();
    const manifest = {
      generated_at_utc: new Date().toISOString(),
      source: "ChatGPT",
      requested_limit: limit,
      returned_count: conversations.length,
      selected_format: requestedFormat,
      export_format: contentFormat,
      conversations: [],
    };

    let exportedCount = 0;
    let firstError = null;

    for (let index = 0; index < conversations.length; index++) {
      const conversation = conversations[index];
      const label = getChatGPTConversationListLabel(conversation);

      try {
        logToPopup(
          `Exporting ${index + 1}/${conversations.length}: ${label}`
        );

        const conversationData = await fetchConversation_ChatGPT(
          conversation.uuid,
          { skipPageContext: true }
        );

        if (!conversationData?.mapping) {
          throw new Error("ChatGPT API returned no conversation mapping");
        }

        if (!conversationData.title && conversation.name) {
          conversationData.title = conversation.name;
        }
        if (!conversationData.id) {
          conversationData.id = conversation.uuid;
        }

        const structuredData = await processChatGPTData(conversationData);
        const output = await formatClaudeBatchConversation(
          structuredData,
          contentFormat
        );
        const filename = buildExportFilenameForData(
          structuredData,
          extension,
          {
            title: conversation.name,
            conversationId: conversation.uuid,
            hashSeed: conversation.uuid,
            platform: "ChatGPT",
          }
        );
        const entryName = buildClaudeBatchEntryName(
          usedNames,
          index,
          filename
        );

        zip.file(entryName, output);
        exportedCount += 1;
        manifest.conversations.push({
          index: index + 1,
          uuid: conversation.uuid,
          title: conversation.name || null,
          updated_at_utc: conversation.updatedAtUtc || null,
          created_at_utc: conversation.createdAtUtc || null,
          filename: entryName,
          status: "ok",
          message_count: Array.isArray(structuredData)
            ? structuredData.length
            : null,
        });
      } catch (error) {
        if (!firstError) firstError = error;
        manifest.conversations.push({
          index: index + 1,
          uuid: conversation.uuid,
          title: conversation.name || null,
          updated_at_utc: conversation.updatedAtUtc || null,
          created_at_utc: conversation.createdAtUtc || null,
          status: "error",
          error: String(error?.message || error),
        });
        console.warn(
          `[ChatGPT Batch] Failed to export ${conversation.uuid}:`,
          error
        );
      }

      if (index < conversations.length - 1) {
        await delay(CLAUDE_BATCH_REQUEST_DELAY_MS);
      }
    }

    manifest.exported_count = exportedCount;
    manifest.failed_count = conversations.length - exportedCount;

    if (!exportedCount) {
      throw new Error(
        `No ChatGPT conversations could be exported. ${
          firstError?.message || "Please refresh and try again."
        }`
      );
    }

    zip.file("_manifest.json", JSON.stringify(manifest, null, 2));

    logToPopup(
      `Generating ChatGPT batch ZIP (${exportedCount}/${conversations.length})...`
    );
    const zipBlob = await zip.generateAsync({ type: "blob" });
    const zipFilename = buildChatGPTBatchZipFilename(
      limit,
      exportedCount,
      conversations
    );

    downloadBlob(zipBlob, zipFilename);
    logToPopup(
      `Batch ZIP ready: ${exportedCount}/${conversations.length} exported`,
      "success"
    );

    return {
      filename: zipFilename,
      exportedCount,
      totalCount: conversations.length,
      failedCount: conversations.length - exportedCount,
    };
  }

  function getQwenConversationListLabel(conversation) {
    const title =
      typeof conversation?.name === "string" && conversation.name.trim()
        ? conversation.name.trim()
        : conversation?.uuid || "Untitled Qwen conversation";
    return title.length > 54 ? `${title.slice(0, 51)}...` : title;
  }

  function buildQwenBatchZipFilename(limit, exportedCount, conversations) {
    const count = exportedCount || limit;
    const ids = Array.isArray(conversations)
      ? conversations.map((item) => item.uuid).filter(Boolean)
      : [];

    if (typeof window.buildExportFilename === "function") {
      return window.buildExportFilename({
        platform: "Qwen",
        theme: `recent-${count}-conversations`,
        extension: "zip",
        hashSeed: ids.join("|") || `${limit}|${Date.now()}`,
      });
    }

    const date = new Date().toISOString().slice(0, 10);
    return `qwen-recent-${count}-conversations-${date}.zip`;
  }

  async function exportQwenRecentConversations(request = {}) {
    const limit = normalizeClaudeBatchLimit(request.limit);
    const requestedFormat = normalizeClaudeBatchFormat(request.format);
    const contentFormat = getClaudeBatchContentFormat(requestedFormat);
    const extension = getClaudeBatchContentExtension(contentFormat);
    const ZipLib =
      (typeof JSZip !== "undefined" ? JSZip : undefined) || window.JSZip;

    if (!ZipLib) {
      throw new Error(
        "JSZip not loaded. Please go to chrome://extensions and reload this extension."
      );
    }

    logToPopup(`Fetching recent ${limit} Qwen conversations...`);
    const conversations = await fetchQwenConversationList(limit);
    if (!conversations.length) {
      throw new Error("Qwen returned no recent conversations.");
    }

    const zip = new ZipLib();
    const usedNames = new Set();
    const manifest = {
      generated_at_utc: new Date().toISOString(),
      source: "Qwen",
      requested_limit: limit,
      returned_count: conversations.length,
      selected_format: requestedFormat,
      export_format: contentFormat,
      conversations: [],
    };
    let exportedCount = 0;
    let firstError = null;

    for (let index = 0; index < conversations.length; index++) {
      const conversation = conversations[index];
      const label = getQwenConversationListLabel(conversation);
      try {
        logToPopup(
          `Exporting ${index + 1}/${conversations.length}: ${label}`
        );
        const conversationData = await fetchQwenConversation(conversation.uuid);
        const structuredData = await processQwenData(conversationData, {
          conversationId: conversation.uuid,
          includeImageData: contentFormat === "html",
        });
        const output = await formatClaudeBatchConversation(
          structuredData,
          contentFormat
        );
        const filename = buildExportFilenameForData(
          structuredData,
          extension,
          {
            title: conversation.name,
            conversationId: conversation.uuid,
            hashSeed: conversation.uuid,
            platform: "Qwen",
          }
        );
        const entryName = buildClaudeBatchEntryName(
          usedNames,
          index,
          filename
        );

        zip.file(entryName, output);
        exportedCount += 1;
        manifest.conversations.push({
          index: index + 1,
          uuid: conversation.uuid,
          title: conversation.name || null,
          updated_at_utc: conversation.updatedAtUtc || null,
          created_at_utc: conversation.createdAtUtc || null,
          filename: entryName,
          status: "ok",
          extraction_mode:
            getExportMeta(structuredData)?.extractionMode || null,
          message_count: structuredData.length,
        });
      } catch (error) {
        if (!firstError) firstError = error;
        manifest.conversations.push({
          index: index + 1,
          uuid: conversation.uuid,
          title: conversation.name || null,
          updated_at_utc: conversation.updatedAtUtc || null,
          created_at_utc: conversation.createdAtUtc || null,
          status: "error",
          error: String(error?.message || error),
        });
        console.warn(
          `[Qwen Batch] Failed to export ${conversation.uuid}:`,
          error
        );
      }

      if (index < conversations.length - 1) {
        await delay(CLAUDE_BATCH_REQUEST_DELAY_MS);
      }
    }

    manifest.exported_count = exportedCount;
    manifest.failed_count = conversations.length - exportedCount;
    if (!exportedCount) {
      throw new Error(
        `No Qwen conversations could be exported. ${
          firstError?.message || "Please refresh and try again."
        }`
      );
    }

    zip.file("_manifest.json", JSON.stringify(manifest, null, 2));
    logToPopup(
      `Generating Qwen batch ZIP (${exportedCount}/${conversations.length})...`
    );
    let lastZipProgress = 0;
    const zipBlob = await zip.generateAsync({ type: "blob" }, (metadata) => {
      const percent = Math.floor(metadata.percent || 0);
      if (percent >= lastZipProgress + 20 || percent === 100) {
        lastZipProgress = percent;
        logToPopup(`Generating Qwen batch ZIP: ${percent}%`);
      }
    });
    const zipFilename = buildQwenBatchZipFilename(
      limit,
      exportedCount,
      conversations
    );
    downloadBlob(zipBlob, zipFilename);
    logToPopup(
      `Qwen batch ZIP ready: ${exportedCount}/${conversations.length} exported`,
      "success"
    );

    return {
      filename: zipFilename,
      exportedCount,
      totalCount: conversations.length,
      failedCount: conversations.length - exportedCount,
    };
  }

  async function exportClaudeRecentConversations(request = {}) {
    const limit = normalizeClaudeBatchLimit(request.limit);
    const requestedFormat = normalizeClaudeBatchFormat(request.format);
    const contentFormat = getClaudeBatchContentFormat(requestedFormat);
    const extension = getClaudeBatchContentExtension(contentFormat);
    const orgId = getClaudeOrganizationIdFromPage();

    if (!orgId) {
      throw new Error(
        "Could not find Claude organization ID. Please refresh and try again."
      );
    }

    const ZipLib =
      (typeof JSZip !== "undefined" ? JSZip : undefined) || window.JSZip;
    if (!ZipLib) {
      throw new Error(
        "JSZip not loaded. Please go to chrome://extensions and reload this extension."
      );
    }

    logToPopup(`Fetching recent ${limit} Claude conversations...`);
    const conversations = await fetchClaudeConversationList(orgId, limit);
    if (!conversations.length) {
      throw new Error("Claude returned no recent conversations.");
    }

    const zip = new ZipLib();
    const usedNames = new Set();
    const manifest = {
      generated_at_utc: new Date().toISOString(),
      source: "Claude",
      organization_id: orgId,
      requested_limit: limit,
      returned_count: conversations.length,
      selected_format: requestedFormat,
      export_format: contentFormat,
      conversations: [],
    };

    let exportedCount = 0;
    let firstError = null;

    for (let index = 0; index < conversations.length; index++) {
      const conversation = conversations[index];
      const label = getClaudeConversationListLabel(conversation);

      try {
        logToPopup(
          `Exporting ${index + 1}/${conversations.length}: ${label}`
        );

        const conversationData = await fetchConversation_Claude(
          orgId,
          conversation.uuid,
          {
            consistency: "strong",
            timeoutMs: 15000,
          }
        );

        if (!hasClaudeConversationMessages(conversationData)) {
          throw new Error("Claude API returned no messages");
        }

        const structuredData = await processClaudeData(conversationData, {
          includeImageData: contentFormat === "html",
        });
        const output = await formatClaudeBatchConversation(
          structuredData,
          contentFormat
        );
        const filename = buildExportFilenameForData(
          structuredData,
          extension,
          {
            title: conversation.name,
            conversationId: conversation.uuid,
            hashSeed: conversation.uuid,
          }
        );
        const entryName = buildClaudeBatchEntryName(
          usedNames,
          index,
          filename
        );

        zip.file(entryName, output);
        exportedCount += 1;
        manifest.conversations.push({
          index: index + 1,
          uuid: conversation.uuid,
          title: conversation.name || null,
          updated_at_utc: conversation.updatedAtUtc || null,
          created_at_utc: conversation.createdAtUtc || null,
          filename: entryName,
          status: "ok",
          message_count: Array.isArray(structuredData)
            ? structuredData.length
            : null,
        });
      } catch (error) {
        if (!firstError) firstError = error;
        manifest.conversations.push({
          index: index + 1,
          uuid: conversation.uuid,
          title: conversation.name || null,
          updated_at_utc: conversation.updatedAtUtc || null,
          created_at_utc: conversation.createdAtUtc || null,
          status: "error",
          error: String(error?.message || error),
        });
        console.warn(
          `[Claude Batch] Failed to export ${conversation.uuid}:`,
          error
        );
      }

      if (index < conversations.length - 1) {
        await delay(CLAUDE_BATCH_REQUEST_DELAY_MS);
      }
    }

    manifest.exported_count = exportedCount;
    manifest.failed_count = conversations.length - exportedCount;

    if (!exportedCount) {
      throw new Error(
        `No Claude conversations could be exported. ${
          firstError?.message || "Please refresh and try again."
        }`
      );
    }

    zip.file("_manifest.json", JSON.stringify(manifest, null, 2));

    logToPopup(
      `Generating batch ZIP (${exportedCount}/${conversations.length})...`
    );
    let lastZipProgress = 0;
    const zipBlob = await zip.generateAsync({ type: "blob" }, (metadata) => {
      const percent = Math.floor(metadata.percent || 0);
      if (percent >= lastZipProgress + 20 || percent === 100) {
        lastZipProgress = percent;
        logToPopup(`Generating batch ZIP: ${percent}%`);
      }
    });
    const zipFilename = buildClaudeBatchZipFilename(
      limit,
      exportedCount,
      conversations
    );

    downloadBlob(zipBlob, zipFilename);
    logToPopup(
      `Batch ZIP ready: ${exportedCount}/${conversations.length} exported`,
      "success"
    );

    return {
      filename: zipFilename,
      exportedCount,
      totalCount: conversations.length,
      failedCount: conversations.length - exportedCount,
    };
  }

  // --- Main Message Listener ---

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (
      request.action === "START_PLATFORM_BATCH_EXPORT" ||
      request.action === "START_CLAUDE_BATCH_EXPORT"
    ) {
      sendResponse({ status: "started" });

      (async () => {
        try {
          let result = null;

          if (
            window.location.href.includes("chatgpt.com") ||
            window.location.href.includes("chat.openai.com")
          ) {
            result = await exportChatGPTRecentConversations(request);
          } else if (window.location.href.includes("chat.qwen.ai")) {
            result = await exportQwenRecentConversations(request);
          } else if (window.location.href.includes("claude.ai")) {
            result = await exportClaudeRecentConversations(request);
          } else {
            throw new Error(
              "Recent batch export currently supports ChatGPT, Claude, and Qwen in this content script."
            );
          }

          chrome.runtime.sendMessage({
            action: "SCRAPE_COMPLETE",
            format: "zip",
            filename: result.filename,
            directDownload: true,
          });
        } catch (error) {
          console.error("Recent batch export error:", error);
          chrome.runtime.sendMessage({
            action: "SCRAPE_ERROR",
            error: error.message,
          });
        }
      })();

      return false;
    }

    if (request.action === "START_SCRAPE") {
      sendResponse({ status: "started" });

      (async () => {
        try {
          const url = window.location.href;
          const targetFormat = request.format || "markdown";
          let structuredData = [];

          if (url.includes("aistudio.google.com")) {
            // AI Studio Logic: use the page's authenticated MakerSuite RPC
            // response first; virtualized DOM scrolling is only a fallback.
            const aiStudioOptions = {
              captureMedia: targetFormat === "html" || targetFormat === "json",
              expandThinking: targetFormat === "html" || targetFormat === "json",
            };

            try {
              chrome.runtime.sendMessage({
                action: "UPDATE_STATUS",
                status: "Reading AI Studio RPC data...",
              });
              structuredData = await fetchAIStudioDataFromRpc({
                includeAttachments: request.includeAttachments !== false,
              });
              console.info(
                `[AI Studio RPC] Exporting ${structuredData.length} structured entries without scrolling.`
              );
            } catch (aiStudioRpcError) {
              console.info(
                "[AI Studio RPC] RPC unavailable; using DOM fallback:",
                aiStudioRpcError
              );

              chrome.runtime.sendMessage({
                action: "UPDATE_STATUS",
                status: "RPC unavailable: using page fallback...",
              });
              await autoScroll(aiStudioOptions);

              chrome.runtime.sendMessage({
                action: "UPDATE_STATUS",
                status: "Extracting page fallback...",
              });
              await extractDataIncremental(aiStudioOptions);
              structuredData = Array.from(collectedData.values()).sort(
                (a, b) => a.domOrder - b.domOrder
              );
            }
          } else if (
            url.includes("chatgpt.com") ||
            url.includes("chat.openai.com")
          ) {
            // ChatGPT Logic
            chrome.runtime.sendMessage({
              action: "UPDATE_STATUS",
              status: "Fetching Data...",
            });

            const chatId = getChatIdFromUrl();
            if (!chatId)
              throw new Error(
                "Could not find Chat ID. Please open a specific conversation."
              );

            try {
              const convData = await fetchConversation_ChatGPT(chatId);
              chrome.runtime.sendMessage({
                action: "UPDATE_STATUS",
                status: "Processing Images...",
              });

              structuredData = await processChatGPTData(convData);
            } catch (chatFetchError) {
              const chatFetchMessage = String(chatFetchError?.message || "");
              const isExpected404 =
                /Failed to fetch conversation:\s*404/i.test(chatFetchMessage);
              const reason = isExpected404 ? "API 404" : "API/page-context failure";
              console.info(
                `[ChatGPT Fetch] ${reason}, falling back to DOM extraction.`
              );

              chrome.runtime.sendMessage({
                action: "UPDATE_STATUS",
                status: "Fallback: Extracting from page...",
              });

              structuredData = extractChatGPTDataFromDOM();
              if (!structuredData.length) {
                throw chatFetchError;
              }
            }

          } else if (url.includes("chat.qwen.ai")) {
            chrome.runtime.sendMessage({
              action: "UPDATE_STATUS",
              status: "Fetching Qwen conversation...",
            });

            const chatId = getQwenConversationIdFromUrl();
            if (!chatId) {
              throw new Error(
                "Could not find Qwen conversation ID. Open a specific Qwen conversation first."
              );
            }

            try {
              const conversationData = await fetchQwenConversation(chatId);
              chrome.runtime.sendMessage({
                action: "UPDATE_STATUS",
                status: "Processing Qwen messages...",
              });
              structuredData = await processQwenData(conversationData, {
                conversationId: chatId,
                includeImageData: targetFormat === "html",
              });
            } catch (qwenFetchError) {
              console.info(
                "[Qwen Fetch] History API unavailable; using DOM fallback:",
                qwenFetchError
              );
              chrome.runtime.sendMessage({
                action: "UPDATE_STATUS",
                status: "Qwen API unavailable: using page fallback...",
              });
              structuredData = extractQwenDataFromDOM();
              if (!structuredData.length) throw qwenFetchError;
              if (targetFormat === "html") {
                await hydrateQwenMedia(structuredData);
              }
            }
          } else if (url.includes("claude.ai")) {
            // Claude Logic
            chrome.runtime.sendMessage({
              action: "UPDATE_STATUS",
              status: "Fetching Claude data...",
            });

            const chatId = getClaudeChatIdFromUrl();
            if (!chatId) {
              throw new Error(
                "Could not find Claude Chat ID. Please open a specific conversation."
              );
            }

            if (shouldPreferClaudeDomExtraction(targetFormat)) {
              chrome.runtime.sendMessage({
                action: "UPDATE_STATUS",
                status: "Extracting Claude page...",
              });

              structuredData = extractClaudeDataFromDOM();
            }

            try {
              if (!structuredData.length) {
                const orgId = getClaudeOrganizationIdFromPage();
                if (!orgId) {
                  throw new Error(
                    "Could not find Claude organization ID. Please refresh and try again."
                  );
                }

                let convData = null;

                if (targetFormat !== "html") {
                  try {
                    convData = await fetchConversation_Claude(orgId, chatId, {
                      timeoutMs: 4000,
                    });
                  } catch (fastClaudeError) {
                    try {
                      convData = await fetchConversation_Claude(orgId, chatId, {
                        consistency: "strong",
                        timeoutMs: 8000,
                      });
                    } catch (retryClaudeError) {
                      markClaudeApiCoolingDown();
                    }
                  }
                } else {
                  try {
                    convData = await fetchConversation_Claude(orgId, chatId, {
                      consistency: "strong",
                      timeoutMs: 8000,
                    });
                  } catch (claudeHtmlError) {
                    markClaudeApiCoolingDown();
                  }
                }

                if (!hasClaudeConversationMessages(convData)) {
                  throw new Error("Claude API returned no messages");
                }

                chrome.runtime.sendMessage({
                  action: "UPDATE_STATUS",
                  status: "Processing Claude messages...",
                });

                structuredData = await processClaudeData(convData, {
                  includeImageData: targetFormat === "html",
                });
              }
            } catch (claudeFetchError) {
              markClaudeApiCoolingDown();

              chrome.runtime.sendMessage({
                action: "UPDATE_STATUS",
                status: "Fallback: Extracting Claude page...",
              });

              structuredData = extractClaudeDataFromDOM();
              if (!structuredData.length) {
                throw claudeFetchError;
              }
            }
          } else {
            throw new Error("Unsupported platform");
          }

          // Format Data
          let finalOutput = "";

          if (targetFormat === "html") {
            finalOutput = await generateHTML(structuredData);
          } else if (targetFormat === "json") {
            finalOutput = formatData(structuredData, "json");
          } else {
            // Default Markdown
            finalOutput = formatData(structuredData, "markdown");
          }

          const extension =
            targetFormat === "json"
              ? "json"
              : targetFormat === "text"
                ? "txt"
                : targetFormat === "html"
                  ? "html"
                  : targetFormat === "zip"
                    ? "zip"
                    : "md";
          const exportFilename = buildExportFilenameForData(
            structuredData,
            extension
          );

          // Output Handling
          if (targetFormat === "zip") {
            // For ZIP, we primarily export Markdown with detached resources
            const md = formatData(structuredData, "markdown");
            await exportWithPackaging(md, "full", {
              filename: exportFilename,
              markdownFilename: buildExportFilenameForData(structuredData, "md"),
            });

            chrome.runtime.sendMessage({
              action: "SCRAPE_COMPLETE",
              format: "zip",
              filename: exportFilename,
            });
          } else if (targetFormat === "html") {
            const blob = new Blob([finalOutput], {
              type: "text/html;charset=utf-8",
            });
            downloadBlob(blob, exportFilename);
            chrome.runtime.sendMessage({
              action: "SCRAPE_COMPLETE",
              format: "html",
              filename: exportFilename,
              directDownload: true,
            });
          } else if (targetFormat === "markdown" && request.download) {
            const blob = new Blob([finalOutput], {
              type: "text/markdown;charset=utf-8",
            });
            downloadBlob(blob, exportFilename);
            chrome.runtime.sendMessage({
              action: "SCRAPE_COMPLETE",
              format: "markdown",
              filename: exportFilename,
              directDownload: true,
            });
          } else {
            // Send back to popup (clipboard copy)
            chrome.runtime.sendMessage({
              action: "SCRAPE_COMPLETE",
              data: finalOutput,
              copyToClipboard: !request.download,
              download: request.download,
              filename: exportFilename,
              format: targetFormat,
            });
          }
        } catch (error) {
          console.error("Scraping error:", error);
          chrome.runtime.sendMessage({
            action: "SCRAPE_ERROR",
            error: error.message,
          });
        }
      })();

      return false;
    }
  });
})();
