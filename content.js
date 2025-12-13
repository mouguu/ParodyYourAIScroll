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
  async function extractDataIncremental() {
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

      if (turnContainer.classList.contains("user")) {
        info.type = "user";

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

              try {
                const base64 = await fetchAsBase64(src);
                if (base64) {
                  info.images.push({ alt, base64 });
                  updated = true;
                  // Also append to text for markdown if it's not already there
                  if (info.userText && !info.userText.includes(src)) {
                    info.userText += `\n\n![${alt}](${src})`;
                  }
                }
              } catch (e) {
                console.error("Failed to convert image to base64:", e);
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

              try {
                const base64 = await fetchAsBase64(video.src);
                if (base64) {
                  info.videos.push({ filename, base64 });
                  updated = true;
                  if (info.userText && !info.userText.includes(video.src)) {
                    info.userText += `\n\n[${filename}](${video.src})`;
                  }
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
      } else if (turnContainer.classList.contains("model")) {
        info.type = "model";
        await expandThinkingSections(turn);

        // Thought
        if (!info.thoughtText) {
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
  async function autoScroll() {
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
    await extractDataIncremental();

    let reachedEnd = false;
    let scrollIncrement = SCROLL_INCREMENT_INITIAL;

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

      let target = currentTop + scrollIncrement;
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

      await extractDataIncremental();

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
    await extractDataIncremental();

    if (isWindow) window.scrollTo(0, document.documentElement.scrollHeight);
    else scroller.scrollTop = scroller.scrollHeight;
    await delay(FINAL_COLLECTION_DELAY_MS);
    await extractDataIncremental();

    isScrolling = false;
    return true;
  }

  // 5. Format Data
  function formatData(data, format = "markdown") {
    const sorted =
      data ||
      Array.from(collectedData.values()).sort(
        (a, b) => a.domOrder - b.domOrder
      );

    if (format === "json") {
      return JSON.stringify(sorted, null, 2);
    }

    if (format === "html") {
      return generateHTML(sorted);
    }

    // Markdown with YAML Frontmatter
    const date = new Date().toISOString().split("T")[0];
    const title = document.title || "AI Chat Export";
    let md = `---
title: "${title}"
date: ${date}
source: "Google AI Studio"
model: "Gemini"
tags: [AI, Chat, Export]
---

# ${title}

`;

    sorted.forEach((item) => {
      if (item.type === "user" && item.userText) {
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
    return md;
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
        item.type === "user" ? "User" : "Model"
      }</div>`;

      if (item.type === "user") {
        // User card with glass effect
        content += `<div class="user-card">`;

        // Add text content
        if (item.userText) {
          const textOnly = item.userText
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
  async function exportWithPackaging(markdown, mode = "text") {
    console.log("exportWithPackaging called with mode:", mode);

    if (mode === "text") {
      const blob = new Blob([markdown], {
        type: "text/markdown;charset=utf-8",
      });
      downloadBlob(blob, `AIStudio_${Date.now()}.md`);
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
      zip.file("chat_history.md", markdown);
      const zipBlob = await zip.generateAsync({ type: "blob" });
      console.log("ZIP generated, size:", zipBlob.size);

      downloadBlob(zipBlob, `AIStudio_${Date.now()}.zip`);

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

  async function fetchConversation_ChatGPT(chatId) {
    const apiUrl = getApiUrl();
    // Wait for the injected script to retrieve the token
    const accessToken = await getAccessToken();

    if (!accessToken)
      throw new Error(
        "Could not find Access Token. Please refresh the page and try again."
      );

    const response = await fetch(`${apiUrl}/conversation/${chatId}`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(
        `Failed to fetch conversation: ${response.status} ${response.statusText}`
      );
    }

    return await response.json();
  }

  async function resolveImageAssets(conversation) {
    const mapping = conversation.mapping;
    const apiUrl = getApiUrl();
    const accessToken = await getAccessToken();

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

  // --- Main Message Listener ---

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "START_SCRAPE") {
      sendResponse({ status: "started" });

      (async () => {
        try {
          const url = window.location.href;
          let structuredData = [];

          if (url.includes("aistudio.google.com")) {
            // AI Studio Logic
            chrome.runtime.sendMessage({
              action: "UPDATE_STATUS",
              status: "Scrolling...",
            });
            await autoScroll();

            chrome.runtime.sendMessage({
              action: "UPDATE_STATUS",
              status: "Extracting...",
            });
            await extractDataIncremental();
            structuredData = Array.from(collectedData.values()).sort(
              (a, b) => a.domOrder - b.domOrder
            );
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

            const convData = await fetchConversation_ChatGPT(chatId);
            chrome.runtime.sendMessage({
              action: "UPDATE_STATUS",
              status: "Processing Images...",
            });

            structuredData = await processChatGPTData(convData);
          } else {
            throw new Error("Unsupported platform");
          }

          // Format Data
          let finalOutput = "";
          const targetFormat = request.format || "markdown";

          if (targetFormat === "html") {
            finalOutput = await generateHTML(structuredData);
          } else if (targetFormat === "json") {
            finalOutput = JSON.stringify(structuredData, null, 2);
          } else {
            // Default Markdown
            finalOutput = formatData(structuredData, "markdown");
          }

          // Output Handling
          if (targetFormat === "zip") {
            // For ZIP, we primarily export Markdown with detached resources
            const md = formatData(structuredData, "markdown");
            await exportWithPackaging(md, "full");

            chrome.runtime.sendMessage({
              action: "SCRAPE_COMPLETE",
              format: "zip",
            });
          } else if (targetFormat === "html") {
            const blob = new Blob([finalOutput], {
              type: "text/html;charset=utf-8",
            });
            downloadBlob(blob, `export_${Date.now()}.html`);
            chrome.runtime.sendMessage({
              action: "SCRAPE_COMPLETE",
              format: "html",
              directDownload: true,
            });
          } else if (targetFormat === "markdown" && request.download) {
            const blob = new Blob([finalOutput], {
              type: "text/markdown;charset=utf-8",
            });
            downloadBlob(blob, `export_${Date.now()}.md`);
            chrome.runtime.sendMessage({
              action: "SCRAPE_COMPLETE",
              format: "markdown",
              directDownload: true,
            });
          } else {
            // Send back to popup (clipboard copy)
            chrome.runtime.sendMessage({
              action: "SCRAPE_COMPLETE",
              data: finalOutput,
              copyToClipboard: !request.download,
              download: request.download,
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
