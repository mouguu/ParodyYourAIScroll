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
        });
        newlyFound = true;
      }

      let info = collectedData.get(turnKey);
      let updated = false;

      if (turnContainer.classList.contains("user")) {
        info.type = "user";
        if (!info.userText) {
          // Try Raw
          const raw = turn.querySelector(
            "ms-text-chunk .very-large-text-container"
          );
          if (raw) info.userText = raw.textContent.trim();
          else {
            // Try Rendered
            const node = turn.querySelector(".turn-content ms-cmark-node");
            if (node) info.userText = node.innerText.trim();
          }
          if (info.userText) updated = true;
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
          const responseChunks = Array.from(
            turn.querySelectorAll(".turn-content > ms-prompt-chunk")
          );
          const texts = responseChunks
            .filter((chunk) => !chunk.querySelector("ms-thought-chunk"))
            .map((chunk) => {
              const raw = chunk.querySelector(
                "ms-text-chunk .very-large-text-container"
              );
              if (raw) return raw.textContent.trim();
              const cmark = chunk.querySelector("ms-cmark-node");
              if (cmark) return cmark.innerText.trim();
              return chunk.innerText.trim();
            })
            .filter((t) => t);

          if (texts.length > 0) {
            info.responseText = texts.join("\n\n");
            updated = true;
          } else if (!info.thoughtText) {
            // Fallback
            const content = turn.querySelector(".turn-content");
            if (content) {
              info.responseText = content.innerText.trim();
              updated = true;
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
  function formatData(format = "markdown") {
    const sorted = Array.from(collectedData.values()).sort(
      (a, b) => a.domOrder - b.domOrder
    );

    if (format === "json") {
      return JSON.stringify(sorted, null, 2);
    }

    let md = "Google AI Studio Chat Export\n============================\n\n";
    sorted.forEach((item) => {
      if (item.type === "user" && item.userText) {
        md += `**User**:\n${item.userText}\n\n`;
      } else if (item.type === "model") {
        if (item.thoughtText) {
          md += `*Thinking*:\n${item.thoughtText}\n\n`;
        }
        if (item.responseText) {
          md += `**Model**:\n${item.responseText}\n\n`;
        }
      }
      md += "---\n\n";
    });
    return md;
  }

  // Message Listener
  // --- ChatGPT Logic ---

  function getMainScrollerElement_ChatGPT() {
    // ChatGPT usually scrolls the main conversation container
    // Try to find the element that has 'overflow-y-auto'
    const candidates = document.querySelectorAll(
      'div[class*="overflow-y-auto"]'
    );
    for (const candidate of candidates) {
      if (candidate.scrollHeight > candidate.clientHeight) {
        return candidate;
      }
    }
    return document.documentElement; // Fallback
  }

  async function extractData_ChatGPT() {
    // ChatGPT structure: article elements usually represent messages
    const articles = document.querySelectorAll("article");
    let markdown = "";

    articles.forEach((article) => {
      const isUser = article.querySelector('[data-message-author-role="user"]');
      const isAssistant = article.querySelector(
        '[data-message-author-role="assistant"]'
      );

      let role = "Unknown";
      if (isUser) role = "User";
      if (isAssistant) role = "Assistant";

      // Extract text content
      // This is a simplified extraction. A robust one would parse the HTML more carefully.
      const contentDiv =
        article.querySelector(".markdown") ||
        article.querySelector("[data-message-author-role]");
      let text = "";

      if (contentDiv) {
        // Extract text content directly
        text = contentDiv.innerText || contentDiv.textContent || "";
      } else {
        text = article.innerText;
      }

      markdown += `**${role}**:\n\n${text}\n\n---\n\n`;
    });

    return markdown;
  }

  async function autoScroll_ChatGPT() {
    const scroller = getMainScrollerElement_ChatGPT();
    if (!scroller) return;

    // Scroll to top first
    scroller.scrollTop = 0;
    await delay(500);

    let lastScrollTop = -1;
    let noChangeCount = 0;

    while (true) {
      scroller.scrollTop += 300; // Scroll down
      await delay(200);

      if (Math.abs(scroller.scrollTop - lastScrollTop) < 5) {
        noChangeCount++;
      } else {
        noChangeCount = 0;
        lastScrollTop = scroller.scrollTop;
      }

      // Check if we reached the bottom
      if (
        scroller.scrollTop + scroller.clientHeight >=
          scroller.scrollHeight - 10 ||
        noChangeCount > 10
      ) {
        break;
      }
    }
  }

  // --- Main Message Listener ---

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "START_SCRAPE") {
      (async () => {
        try {
          const url = window.location.href;
          let markdown = "";
          if (url.includes("aistudio.google.com")) {
            // AI Studio Logic
            chrome.runtime.sendMessage({ action: "UPDATE_STATUS", status: "Scrolling..." });
            await autoScroll();
            
            chrome.runtime.sendMessage({ action: "UPDATE_STATUS", status: "Extracting..." });
            // Re-detect mode after scrolling
            // The original extractDataIncremental returns a boolean, not markdown.
            // We need to call formatData after extraction for AI Studio.
            await extractDataIncremental(); // Populate collectedData
            markdown = formatData(request.format || 'markdown'); // Then format it
          } else if (
            url.includes("chatgpt.com") ||
            url.includes("chat.openai.com")
          ) {
            // ChatGPT Logic
            chrome.runtime.sendMessage({
              action: "UPDATE_STATUS",
              status: "Scrolling...",
            });
            await autoScroll_ChatGPT();

            chrome.runtime.sendMessage({
              action: "UPDATE_STATUS",
              status: "Extracting...",
            });
            markdown = await extractData_ChatGPT();
          } else {
            throw new Error("Unsupported platform");
          }

          chrome.runtime.sendMessage({
            action: "SCRAPE_COMPLETE",
            data: markdown, // Changed payload to data to match original structure
            copyToClipboard: !request.download,
            download: request.download,
            format: request.format,
          });
        } catch (error) {
          console.error("Scraping error:", error);
          chrome.runtime.sendMessage({
            action: "SCRAPE_ERROR",
            error: error.message,
          });
        }
      })();

      // Return true to indicate async response (though we use sendMessage for updates)
      return true;
    }
  });
})();
