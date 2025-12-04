/**
 * Gemini Chat Exporter Module
 * Standalone module for exporting Gemini conversations
 * Based on: https://greasyfork.org/scripts/549768
 */

(function () {
  "use strict";

  // ===========================
  // Utility Functions
  // ===========================

  function getCurrentTimestamp() {
    return new Date().toISOString().slice(0, 19).replace(/:/g, "-");
  }

  function sanitizeFilename(title) {
    return (title || "Gemini Chat")
      .replace(/[<>:"/\\|?\*]/g, "_")
      .replace(/\s+/g, "_");
  }

  function stdLB(text) {
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ===========================
  // Page State Helpers
  // ===========================

  /**
   * Detect route and build the correct source-path and account-aware RPC base.
   * Supports:
   *   - /app/:chatId
   *   - /gem/:gemId/:chatId
   *   - /u/:index/app/:chatId
   *   - /u/:index/gem/:gemId/:chatId
   */
  function getRouteFromUrl() {
    const path = location.pathname.replace(/\/+$/, "");
    const segs = path.split("/").filter(Boolean);

    if (segs.length === 0) return null;

    let basePrefix = "";
    let userIndex = null;
    let i = 0;

    // Optional "/u/:index" prefix
    if (segs[0] === "u" && /^\d+$/.test(segs[1] || "")) {
      userIndex = segs[1];
      basePrefix = `/u/${userIndex}`;
      i = 2;
    }

    // /app/:chatId
    if (segs[i] === "app" && segs[i + 1]) {
      const chatId = segs[i + 1];
      return {
        kind: "app",
        chatId,
        userIndex,
        basePrefix,
        sourcePath: `${basePrefix}/app/${chatId}`,
      };
    }

    // /gem/:gemId/:chatId
    if (segs[i] === "gem" && segs[i + 1] && segs[i + 2]) {
      const gemId = segs[i + 1];
      const chatId = segs[i + 2];
      return {
        kind: "gem",
        gemId,
        chatId,
        userIndex,
        basePrefix,
        sourcePath: `${basePrefix}/gem/${gemId}/${chatId}`,
      };
    }

    return null;
  }

  function getLang() {
    return document.documentElement.lang || "en";
  }

  function getAtToken() {
    const input = document.querySelector('input[name="at"]');
    if (input?.value) return input.value;

    const html = document.documentElement.innerHTML;
    let m = html.match(/"SNlM0e":"([^"]+)"/);
    if (m) return m[1];

    try {
      if (window.WIZ_global_data?.SNlM0e) return window.WIZ_global_data.SNlM0e;
    } catch {}

    return null;
  }

  function getBatchUrl(route) {
    const prefix = route.basePrefix || "";
    return `${prefix}/_/BardChatUi/data/batchexecute`;
  }

  // ===========================
  // Batchexecute Calls
  // ===========================

  async function fetchConversationPayload(route) {
    const at = getAtToken();
    if (!at)
      throw new Error('Could not find anti-CSRF token "at" on the page.');

    const chatId = route.chatId;
    const convKey = chatId.startsWith("c_") ? chatId : `c_${chatId}`;

    // Use a very large page size to get all messages in one request
    // The original UserScript uses 1000, but we'll use 10000 to be safe
    const innerArgs = JSON.stringify([
      convKey,
      10000, // Increased from 1000 to 10000
      null,
      1,
      [1],
      [4],
      null,
      1,
    ]);
    const fReq = [[["hNvQHb", innerArgs, null, "generic"]]];
    const params = new URLSearchParams({
      rpcids: "hNvQHb",
      "source-path": route.sourcePath,
      hl: getLang(),
      rt: "c",
    });
    const body = new URLSearchParams({ "f.req": JSON.stringify(fReq), at });

    const res = await fetch(`${getBatchUrl(route)}?${params.toString()}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        "x-same-domain": "1",
        accept: "*/*",
      },
      body: body.toString() + "&",
    });

    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(
        `batchexecute failed: ${res.status} ${res.statusText}${
          t ? `\n${t.slice(0, 300)}` : ""
        }`
      );
    }
    return res.text();
  }

  async function fetchConversationTitle(route) {
    const at = getAtToken();
    if (!at) return null;

    const fullChatId = route.chatId.startsWith("c_")
      ? route.chatId
      : `c_${route.chatId}`;

    const tryArgsList = [
      JSON.stringify([13, null, [0, null, 1]]),
      JSON.stringify([200, null, [0, null, 1]]),
      null,
    ];

    for (const innerArgs of tryArgsList) {
      try {
        const fReq = [[["MaZiqc", innerArgs, null, "generic"]]];
        const params = new URLSearchParams({
          rpcids: "MaZiqc",
          "source-path": route.sourcePath,
          hl: getLang(),
          rt: "c",
        });
        const body = new URLSearchParams({ "f.req": JSON.stringify(fReq), at });

        const res = await fetch(`${getBatchUrl(route)}?${params.toString()}`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
            "x-same-domain": "1",
            accept: "*/*",
          },
          body: body.toString() + "&",
        });

        if (!res.ok) continue;

        const text = await res.text();
        const payloads = parseBatchExecute(text, "MaZiqc");

        for (const payload of payloads) {
          const title = findTitleInPayload(payload, fullChatId);
          if (title) return title;
        }
      } catch {
        // Try next argument pattern
      }
    }
    return null;
  }

  function findTitleInPayload(root, fullChatId) {
    let found = null;
    (function walk(node) {
      if (found) return;
      if (Array.isArray(node)) {
        if (
          node.length >= 2 &&
          typeof node[0] === "string" &&
          node[0] === fullChatId &&
          typeof node[1] === "string" &&
          node[1].trim()
        ) {
          found = node[1].trim();
          return;
        }
        for (const child of node) walk(child);
      }
    })(root);
    return found;
  }

  // ===========================
  // Google Batchexecute Parser
  // ===========================

  function parseBatchExecute(text, targetRpcId = "hNvQHb") {
    if (text.startsWith(")]}'\n")) {
      const nl = text.indexOf("\n");
      text = nl >= 0 ? text.slice(nl + 1) : "";
    }
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    const payloads = [];

    for (let i = 0; i < lines.length; ) {
      const lenStr = lines[i++];
      const len = parseInt(lenStr, 10);
      if (!isFinite(len)) break;
      const jsonLine = lines[i++] || "";
      let segment;
      try {
        segment = JSON.parse(jsonLine);
      } catch {
        continue;
      }
      if (Array.isArray(segment)) {
        for (const entry of segment) {
          if (
            Array.isArray(entry) &&
            entry[0] === "wrb.fr" &&
            entry[1] === targetRpcId
          ) {
            const s = entry[2];
            if (typeof s === "string") {
              try {
                const inner = JSON.parse(s);
                payloads.push(inner);
              } catch {
                // ignore
              }
            }
          }
        }
      }
    }
    return payloads;
  }

  // ===========================
  // Conversation Extraction
  // ===========================

  function isUserMessageNode(node) {
    return (
      Array.isArray(node) &&
      node.length >= 2 &&
      Array.isArray(node[0]) &&
      node[0].length >= 1 &&
      node[0].every((p) => typeof p === "string") &&
      (node[1] === 2 || node[1] === 1)
    );
  }

  function getUserTextFromNode(userNode) {
    try {
      return userNode[0].join("\n");
    } catch {
      return "";
    }
  }

  function isAssistantNode(node) {
    return (
      Array.isArray(node) &&
      node.length >= 2 &&
      typeof node[0] === "string" &&
      node[0].startsWith("rc_") &&
      Array.isArray(node[1]) &&
      typeof node[1][0] === "string"
    );
  }

  function isAssistantContainer(node) {
    return (
      Array.isArray(node) &&
      node.length >= 1 &&
      Array.isArray(node[0]) &&
      node[0].length >= 1 &&
      isAssistantNode(node[0][0])
    );
  }

  function getAssistantNodeFromContainer(container) {
    try {
      return container[0][0];
    } catch {
      return null;
    }
  }

  function getAssistantTextFromNode(assistantNode) {
    try {
      return assistantNode[1][0] || "";
    } catch {
      return "";
    }
  }

  function extractReasoningFromAssistantNode(assistantNode) {
    if (!Array.isArray(assistantNode)) return null;
    for (let k = assistantNode.length - 1; k >= 0; k--) {
      const child = assistantNode[k];
      if (Array.isArray(child)) {
        if (
          child.length >= 2 &&
          Array.isArray(child[1]) &&
          child[1].length >= 1 &&
          Array.isArray(child[1][0]) &&
          child[1][0].length >= 1 &&
          child[1][0].every((x) => typeof x === "string")
        ) {
          const txt = child[1][0].join("\n\n").trim();
          if (txt) return txt;
        }
        if (
          Array.isArray(child[0]) &&
          child[0].length >= 1 &&
          child[0].every((x) => typeof x === "string")
        ) {
          const txt = child[0].join("\n\n").trim();
          if (txt) return txt;
        }
      }
    }
    return null;
  }

  function isTimestampPair(arr) {
    return (
      Array.isArray(arr) &&
      arr.length === 2 &&
      typeof arr[0] === "number" &&
      typeof arr[1] === "number" &&
      arr[0] > 1_600_000_000
    );
  }

  function cmpTimestampAsc(a, b) {
    if (!a.tsPair && !b.tsPair) return 0;
    if (!a.tsPair) return -1;
    if (!b.tsPair) return 1;
    if (a.tsPair[0] !== b.tsPair[0]) return a.tsPair[0] - b.tsPair[0];
    return a.tsPair[1] - b.tsPair[1];
  }

  function detectBlock(node) {
    if (!Array.isArray(node)) return null;
    let userNode = null;
    let assistantContainer = null;
    let tsCandidate = null;

    for (const child of node) {
      if (isUserMessageNode(child) && !userNode) userNode = child;
      if (isAssistantContainer(child) && !assistantContainer)
        assistantContainer = child;
      if (isTimestampPair(child)) {
        if (
          !tsCandidate ||
          child[0] > tsCandidate[0] ||
          (child[0] === tsCandidate[0] && child[1] > tsCandidate[1])
        ) {
          tsCandidate = child;
        }
      }
    }
    if (userNode && assistantContainer) {
      const assistantNode = getAssistantNodeFromContainer(assistantContainer);
      if (!assistantNode) return null;
      const userText = getUserTextFromNode(userNode);
      const assistantText = getAssistantTextFromNode(assistantNode);
      const thoughtsText = extractReasoningFromAssistantNode(assistantNode);
      return {
        userText,
        assistantText,
        thoughtsText: thoughtsText || null,
        tsPair: tsCandidate || null,
      };
    }
    return null;
  }

  // New function to extract from Array[5] structure
  function extractFromArray5Structure(item, index) {
    console.log(
      `[Gemini Exporter] Trying Array[5] extraction for item ${index}`
    );

    if (!Array.isArray(item) || item.length !== 5) {
      console.log(`[Gemini Exporter] Not an Array[5], skipping`);
      return null;
    }

    try {
      // Structure: [userMsg, metadata, unknown, assistantMsg, timestamp]
      const userPart = item[0]; // Array[2]
      const assistantPart = item[3]; // Array[22]
      const timestampPart = item[4]; // Array[2]

      let userText = "";
      let assistantText = "";
      let thoughtsText = null;
      let tsPair = null;

      // Extract user text from item[0]
      if (Array.isArray(userPart)) {
        const found = findTextInNode(userPart);
        if (found) userText = found;
      }

      // Extract assistant text and thoughts from item[3]
      if (Array.isArray(assistantPart)) {
        const found = findTextInNode(assistantPart);
        if (found) assistantText = found;

        // Try to find thoughts
        const thoughts = findThoughtsInNode(assistantPart);
        if (thoughts) thoughtsText = thoughts;
      }

      // Extract timestamp from item[4]
      if (isTimestampPair(timestampPart)) {
        tsPair = timestampPart;
      }

      if (userText || assistantText) {
        console.log(
          `[Gemini Exporter] ✓ Extracted from Array[5]: user=${userText.substring(
            0,
            30
          )}..., assistant=${assistantText.substring(0, 30)}...`
        );
        return {
          userText,
          assistantText,
          thoughtsText,
          tsPair,
        };
      }
    } catch (e) {
      console.warn(`[Gemini Exporter] Error extracting from Array[5]:`, e);
    }

    return null;
  }

  // Helper to find text in nested arrays
  function findTextInNode(node, skipIds = true) {
    const texts = [];

    function collect(n, depth = 0) {
      if (depth > 15) return; // Prevent infinite recursion

      if (typeof n === "string" && n.trim()) {
        const trimmed = n.trim();
        // Skip IDs: c_xxx, rc_xxx, r_xxx patterns
        if (skipIds && /^(c_|rc_|r_)[a-f0-9]+$/.test(trimmed)) {
          return;
        }
        // Skip very short strings (likely not content)
        if (trimmed.length > 5) {
          texts.push(trimmed);
        }
      }
      if (Array.isArray(n)) {
        for (const child of n) {
          collect(child, depth + 1);
        }
      }
    }

    collect(node);

    // Return the longest text found (likely the actual content)
    if (texts.length === 0) return null;
    if (texts.length === 1) return texts[0];

    // Return the longest string, as it's most likely the actual message
    return texts.reduce((longest, current) =>
      current.length > longest.length ? current : longest
    );
  }

  // Helper to find thoughts/reasoning
  function findThoughtsInNode(node) {
    if (!Array.isArray(node)) return null;

    const allTexts = [];

    function collect(n, depth = 0) {
      if (depth > 15) return; // Prevent infinite recursion

      if (typeof n === "string" && n.trim()) {
        const trimmed = n.trim();
        // Skip IDs and collect longer texts
        if (!/^(c_|rc_|r_)[a-f0-9]+$/.test(trimmed) && trimmed.length > 50) {
          allTexts.push(trimmed);
        }
      }
      if (Array.isArray(n)) {
        for (const child of n) {
          collect(child, depth + 1);
        }
      }
    }

    collect(node);

    // If we found multiple long texts, try to identify which is the thought
    if (allTexts.length > 1) {
      // Sort by length descending
      allTexts.sort((a, b) => b.length - a.length);
      // Return the second longest (first might be main response)
      // Or if they're similar length, return a different one
      if (
        allTexts.length >= 2 &&
        allTexts[0].length / allTexts[1].length < 1.5
      ) {
        return allTexts[1];
      }
    }

    return allTexts[0] || null;
  }

  function extractBlocksFromPayloadRoot(root) {
    const blocks = [];
    const seenComposite = new Set();

    function scan(node, depth = 0) {
      if (!Array.isArray(node)) return;

      // Debug: Log structure of top-level conversation items
      if (depth === 0) {
        console.log(
          `[Gemini Exporter] Scanning node with ${node.length} children`
        );
        node.forEach((child, idx) => {
          if (Array.isArray(child)) {
            console.log(`  Item ${idx}: Array[${child.length}]`, {
              hasUserNode: child.some(isUserMessageNode),
              hasAssistantContainer: child.some(isAssistantContainer),
              hasTimestamp: child.some(isTimestampPair),
            });
          } else {
            console.log(`  Item ${idx}:`, typeof child, child);
          }
        });
      }

      const block = detectBlock(node);
      if (block) {
        const key = JSON.stringify([
          block.userText,
          block.assistantText,
          block.thoughtsText || "",
          block.tsPair?.[0] || 0,
          block.tsPair?.[1] || 0,
        ]);
        if (!seenComposite.has(key)) {
          seenComposite.add(key);
          blocks.push(block);
          console.log(
            `[Gemini Exporter] ✓ Found block at depth ${depth}, total: ${blocks.length}`
          );
        }
      }

      // Recursively scan children
      for (const child of node) scan(child, depth + 1);
    }

    // The actual conversation data is in root[0], not root itself
    // Based on the structure: payload[0] = Array[9] containing all messages
    // Each message is wrapped in an Array[5] container
    if (Array.isArray(root) && root.length > 0 && Array.isArray(root[0])) {
      console.log(
        `[Gemini Exporter] Scanning conversation array at root[0], length: ${root[0].length}`
      );

      // Try Array[5] extraction first for each item
      root[0].forEach((item, idx) => {
        console.log(`[Gemini Exporter] Processing conversation item ${idx}...`);

        // Try the new Array[5] extraction method
        const block = extractFromArray5Structure(item, idx);
        if (block) {
          const key = JSON.stringify([
            block.userText,
            block.assistantText,
            block.thoughtsText || "",
            block.tsPair?.[0] || 0,
            block.tsPair?.[1] || 0,
          ]);
          if (!seenComposite.has(key)) {
            seenComposite.add(key);
            blocks.push(block);
          }
        } else {
          // Fallback to old method
          console.log(
            `[Gemini Exporter] Array[5] extraction failed, trying recursive scan...`
          );
          scan(item, 0);
        }
      });
    } else {
      // Fallback to scanning entire root if structure is different
      console.log("[Gemini Exporter] Using fallback: scanning entire root");
      scan(root, 0);
    }

    console.log(`[Gemini Exporter] Total blocks extracted: ${blocks.length}`);
    return blocks;
  }

  function extractAllBlocks(payloads) {
    let blocks = [];

    // Debug: Log payload structure
    console.log("[Gemini Exporter] Analyzing payload structure...");
    payloads.forEach((payload, idx) => {
      console.log(
        `[Gemini Exporter] Payload ${idx} type:`,
        Array.isArray(payload) ? "Array" : typeof payload
      );
      if (Array.isArray(payload)) {
        console.log(`[Gemini Exporter] Payload ${idx} length:`, payload.length);
        console.log(
          `[Gemini Exporter] Payload ${idx} first level structure:`,
          payload
            .slice(0, 3)
            .map((item) =>
              Array.isArray(item) ? `Array[${item.length}]` : typeof item
            )
        );

        // Print deeper structure for first payload
        if (idx === 0) {
          console.log("[Gemini Exporter] Deep dive into payload[0]:");
          payload.forEach((item, i) => {
            if (i < 5) {
              // Only first 5 items
              if (Array.isArray(item)) {
                console.log(
                  `  [${i}]: Array[${item.length}]`,
                  item
                    .slice(0, 2)
                    .map((x) =>
                      Array.isArray(x) ? `Array[${x.length}]` : typeof x
                    )
                );
              } else {
                console.log(`  [${i}]:`, typeof item, item);
              }
            }
          });
        }
      }
    });

    for (const p of payloads) {
      const b = extractBlocksFromPayloadRoot(p);
      console.log(
        `[Gemini Exporter] Extracted ${b.length} blocks from this payload`
      );
      blocks = blocks.concat(b);
    }

    const withIndex = blocks.map((b, i) => ({ ...b, _i: i }));
    withIndex.sort((a, b) => {
      const c = cmpTimestampAsc(a, b);
      return c !== 0 ? c : a._i - b._i;
    });
    return withIndex.map(({ _i, ...rest }) => rest);
  }

  // ===========================
  // Markdown Formatter
  // ===========================

  function blocksToMarkdown(blocks, title = "Gemini Chat") {
    const parts = [];

    for (let i = 0; i < blocks.length; i++) {
      const blk = blocks[i];
      const u = (blk.userText || "").trim();
      const a = (blk.assistantText || "").trim();
      const t = (blk.thoughtsText || "").trim();

      const blockParts = [];
      if (u) blockParts.push(`#### User:\n${u}`);
      if (t) blockParts.push(`#### Thoughts:\n${t}`);
      if (a) blockParts.push(`#### Assistant:\n${a}`);

      if (blockParts.length > 0) {
        parts.push(blockParts.join("\n\n---\n\n"));
        if (i < blocks.length - 1) {
          parts.push("---");
        }
      }
    }

    return `# ${title}\n\n${parts.join("\n\n")}\n`;
  }

  function blocksToHtml(blocks, title) {
    // Generate content HTML that matches the template.js structure
    let contentHtml = '';
    
    for (const block of blocks) {
      contentHtml += '<div class="turn">';
      
      // User message
      if (block.userText) {
        contentHtml += `
          <div class="role-label">You</div>
          <div class="user-card">
            <div class="content">${escapeHtml(block.userText).replace(/\n/g, '<br>')}</div>
          </div>`;
      }
      
      // Assistant message
      if (block.assistantText) {
        contentHtml += `
          <div class="role-label" style="margin-top: 24px;">Gemini</div>
          <div class="model-card">
            <div class="model-header">
              <div class="dot red"></div>
              <div class="dot yellow"></div>
              <div class="dot green"></div>
            </div>`;
        
        // Thoughts section (collapsible)
        if (block.thoughtsText) {
          contentHtml += `
            <div class="thinking">
              <div class="thinking-header" onclick="toggleThinking(this)">
                <span class="thinking-title">Thinking Process</span>
                <span class="arrow">↓</span>
              </div>
              <div class="thinking-content">${escapeHtml(block.thoughtsText)}</div>
            </div>`;
        }
        
        contentHtml += `
            <div class="model-content">
              ${escapeHtml(block.assistantText).replace(/\n/g, '<br>')}
            </div>
          </div>`;
      }
      
      contentHtml += '</div>';
    }
    
    // Use the shared template from template.js if available
    const date = new Date().toLocaleDateString('en-US', { 
      year: 'numeric', 
      month: 'long', 
      day: 'numeric' 
    });
    
    if (typeof window.getHTMLTemplate === 'function') {
      return window.getHTMLTemplate(title, date, contentHtml);
    }
    
    // Fallback to basic HTML if template not available
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 800px; margin: 0 auto; padding: 40px 20px; background: #f5f5f7; }
  .turn { margin-bottom: 40px; }
  .role-label { font-size: 12px; font-weight: 600; text-transform: uppercase; color: #666; margin-bottom: 8px; }
  .user-card { background: #fff; padding: 20px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.05); }
  .model-card { background: #1a1a1a; color: #e2e2e2; border-radius: 12px; overflow: hidden; }
  .model-header { background: #111; padding: 8px 12px; display: flex; gap: 6px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; }
  .dot.red { background: #ff5f56; }
  .dot.yellow { background: #ffbd2e; }
  .dot.green { background: #27c93f; }
  .model-content { padding: 20px; line-height: 1.6; }
  .thinking { border-bottom: 1px solid #333; }
  .thinking-header { padding: 12px 20px; cursor: pointer; color: #666; font-size: 12px; }
  .thinking-content { padding: 0 20px 16px; color: #888; font-size: 13px; white-space: pre-wrap; }
</style>
<script>
function toggleThinking(header) {
  const content = header.nextElementSibling;
  content.style.display = content.style.display === 'none' ? 'block' : 'none';
}
</script>
</head><body>
<h1 style="text-align:center;margin-bottom:40px">${title}</h1>
<p style="text-align:center;color:#666;margin-bottom:60px">${date}</p>
${contentHtml}
</body></html>`;
  }

  function blocksToText(blocks, title) {
    let text = `${title}\n${"=".repeat(title.length)}\n\n`;

    for (const block of blocks) {
      if (block.userText) {
        text += `User:\n${block.userText}\n\n`;
      }
      if (block.assistantText) {
        text += `Gemini:\n${block.assistantText}\n\n`;
        if (block.thoughtsText) {
          text += `Thoughts:\n${block.thoughtsText}\n\n`;
        }
      }
      text += `${"-".repeat(20)}\n\n`;
    }
    return text;
  }

  function escapeHtml(unsafe) {
    return unsafe
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // ===========================
  // Main Export Function
  // ===========================

  async function exportGeminiChat(options = {}) {
    try {
      const route = getRouteFromUrl();
      if (!route || !route.chatId) {
        throw new Error(
          "Open a chat at /app/:chatId or /gem/:gemId/:chatId before exporting."
        );
      }

      // Update status
      chrome.runtime.sendMessage({
        action: "UPDATE_STATUS",
        message: "Fetching conversation data...",
        type: "info",
      });

      // Fetch conversation data
      const raw = await fetchConversationPayload(route);
      console.log(`[Gemini Exporter] Raw response length: ${raw.length} chars`);
      
      // Debug: Log first 500 chars of response
      if (raw.length < 1000) {
        console.warn(`[Gemini Exporter] Response seems too short! Content:`, raw);
      }
      
      const payloads = parseBatchExecute(raw);
      console.log(`[Gemini Exporter] Parsed ${payloads.length} payloads`);
      
      // DEBUG: Save payload to window for inspection
      window.__GEMINI_DEBUG_PAYLOAD__ = payloads[0];
      console.log('[Gemini Exporter] 💾 Payload saved to window.__GEMINI_DEBUG_PAYLOAD__ for inspection');
      console.log('[Gemini Exporter] 💡 You can inspect it in console with: window.__GEMINI_DEBUG_PAYLOAD__');
      
      if (!payloads.length) {
        console.error('[Gemini Exporter] Raw response:', raw.substring(0, 500));
        throw new Error(
          "No conversation payloads found in batchexecute response. The API might have returned an error. Check console for details."
        );
      }

      const blocks = extractAllBlocks(payloads);
      console.log(`[Gemini Exporter] Extracted ${blocks.length} message blocks`);
      
      if (!blocks.length)
        throw new Error("Could not extract any User/Assistant message pairs.");

      // Log extraction results
      console.log(`[Gemini Exporter] Extracted ${blocks.length} message blocks`);
      chrome.runtime.sendMessage({
        action: "UPDATE_STATUS",
        message: `Found ${blocks.length} messages, generating export...`,
        type: "info",
      });

      // Try to fetch the actual conversation title
      let title = await fetchConversationTitle(route);
      if (!title) {
        title = document.title?.trim() || "Gemini Chat";
        if (title.includes(" - Gemini")) {
          title = title.split(" - Gemini")[0].trim();
        }
        if (title === "Gemini" || title === "Google Gemini") {
          title = "Gemini Chat";
        }
      }

      // Determine export format
      const format = options.format || 'markdown';
      let content = '';
      let mimeType = 'text/markdown';
      let extension = 'md';

      if (format === 'json') {
        content = JSON.stringify({ title, messages: blocks }, null, 2);
        mimeType = 'application/json';
        extension = 'json';
      } else if (format === 'html') {
        content = blocksToHtml(blocks, title);
        mimeType = 'text/html';
        extension = 'html';
      } else if (format === 'text') {
        content = blocksToText(blocks, title);
        mimeType = 'text/plain';
        extension = 'txt';
      } else {
        // Default to Markdown
        content = stdLB(blocksToMarkdown(blocks, title));
        mimeType = 'text/markdown';
        extension = 'md';
      }

      const filename = `${sanitizeFilename(title)}_${getCurrentTimestamp()}.${extension}`;

      // Check if this is a download request or copy request
      const shouldDownload = window.__GEMINI_EXPORT_MODE__ === 'download' || options.download;
      
      if (shouldDownload) {
        // Send to background for download
        chrome.runtime.sendMessage({
          action: "DOWNLOAD_BLOB",
          url: `data:${mimeType};charset=utf-8,${encodeURIComponent(content)}`,
          filename: filename,
        });

        chrome.runtime.sendMessage({
          action: "UPDATE_STATUS",
          message: `Export successful! (${blocks.length} messages)`,
          type: "success",
        });
      } else {
        // Copy to clipboard
        try {
          await navigator.clipboard.writeText(content);
          chrome.runtime.sendMessage({
            action: "UPDATE_STATUS",
            message: `Copied ${blocks.length} messages to clipboard!`,
            type: "success",
          });
        } catch (clipboardErr) {
          console.error('[Gemini Exporter] Clipboard error:', clipboardErr);
          // Fallback: send data back to popup for copying
          chrome.runtime.sendMessage({
            action: "SCRAPE_COMPLETE",
            data: content,
            copyToClipboard: true,
          });
        }
      }

      return { success: true, filename, content };
    } catch (err) {
      console.error("[Gemini Exporter] Error:", err);
      chrome.runtime.sendMessage({
        action: "UPDATE_STATUS",
        message: `Export failed: ${err?.message || err}`,
        type: "error",
      });
      throw err;
    }
  }

  // ===========================
  // Message Listener
  // ===========================

  // Listen for export mode updates
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "SET_EXPORT_MODE") {
      window.__GEMINI_EXPORT_MODE__ = request.mode;
      console.log(`[Gemini Exporter] Set export mode to: ${request.mode}`);
      sendResponse({ success: true });
    }
  });

  // Listen for messages from the popup
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "START_SCRAPE_GEMINI") {
      console.log("[Gemini Exporter] Received START_SCRAPE_GEMINI command", request);
      
      // Pass the request options (format, download, etc.) to exportGeminiChat
      exportGeminiChat(request)
        .then((result) => {
          console.log("[Gemini Exporter] Export completed:", result);
          sendResponse(result);
        })
        .catch((err) => {
          console.error("[Gemini Exporter] Export failed:", err);
          sendResponse({ success: false, error: err.message });
        });
      return true; // Keep channel open for async response
    }
  });

  // Export for testing
  if (typeof window !== "undefined") {
    window.GeminiExporter = {
      exportGeminiChat,
    };
  }
})();
