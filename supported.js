document.addEventListener("DOMContentLoaded", () => {
  const copyBtn = document.getElementById("copy-btn");
  const downloadBtn = document.getElementById("download-btn");
  const claudeBatchSection = document.getElementById("claude-batch-section");
  const claudeBatchLimit = document.getElementById("claude-batch-limit");
  const claudeBatchCustomLimit = document.getElementById("claude-batch-custom-limit");
  const claudeBatchDownloadBtn = document.getElementById("claude-batch-download-btn");
  const batchSectionLabel = document.getElementById("batch-section-label");
  const statusArea = document.getElementById("status-area");
  const statusText = document.getElementById("status-text");
  const aiStudioAttachmentToggle = document.getElementById(
    "aistudio-attachment-toggle"
  );
  const aiStudioAttachmentDescription = document.getElementById(
    "aistudio-attachment-description"
  );
  const aiStudioAttachmentSwitchLabel = aiStudioAttachmentToggle?.querySelector(
    ".attachment-switch-label"
  );
  const AI_STUDIO_ATTACHMENT_SETTING = "aistudioIncludeAttachmentText";
  let includeAIStudioAttachments = true;

  function renderAIStudioAttachmentToggle() {
    if (!aiStudioAttachmentToggle) return;

    aiStudioAttachmentToggle.classList.toggle(
      "is-on",
      includeAIStudioAttachments
    );
    aiStudioAttachmentToggle.setAttribute(
      "aria-checked",
      String(includeAIStudioAttachments)
    );
    aiStudioAttachmentToggle.setAttribute(
      "aria-label",
      `Attachment text ${includeAIStudioAttachments ? "on" : "off"}`
    );
    if (aiStudioAttachmentSwitchLabel) {
      aiStudioAttachmentSwitchLabel.textContent = includeAIStudioAttachments
        ? "ON"
        : "OFF";
    }
    if (aiStudioAttachmentDescription) {
      aiStudioAttachmentDescription.textContent = includeAIStudioAttachments
        ? "Include pasted files in the export"
        : "Keep file references only";
    }
  }

  chrome.storage.local.get(
    { [AI_STUDIO_ATTACHMENT_SETTING]: true },
    (settings) => {
      includeAIStudioAttachments =
        settings?.[AI_STUDIO_ATTACHMENT_SETTING] !== false;
      renderAIStudioAttachmentToggle();
    }
  );

  aiStudioAttachmentToggle?.addEventListener("click", () => {
    includeAIStudioAttachments = !includeAIStudioAttachments;
    renderAIStudioAttachmentToggle();
    chrome.storage.local.set({
      [AI_STUDIO_ATTACHMENT_SETTING]: includeAIStudioAttachments,
    });
  });

  // Update Header Info based on current tab
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs.length === 0) return;
    
    const url = tabs[0].url;
    const isAIStudio = url && url.includes("aistudio.google.com");
    const isChatGPT = url && (url.includes("chatgpt.com") || url.includes("chat.openai.com"));
    const isGemini = url && url.includes("gemini.google.com");
    const isClaude = url && url.includes("claude.ai");
    const isClaudeRecents = isClaude && (() => {
      try {
        return new URL(url).pathname.startsWith("/recents");
      } catch {
        return false;
      }
    })();

    const pageTitle = document.querySelector(".page-title");
    const urlText = document.querySelector(".url-text");
    const urlIcon = document.querySelector(".url-icon");

    if (isAIStudio) {
      aiStudioAttachmentToggle?.classList.remove("hidden");
      pageTitle.textContent = "GoogleAIStudio - Playground";
      urlText.textContent = "https://aistudio.google.com";
      urlIcon.src = "https://www.gstatic.com/aistudio/ai_studio_favicon_2_32x32.png";
    } else if (isChatGPT) {
      pageTitle.textContent = "ChatGPT - Conversation";
      urlText.textContent = "https://chatgpt.com";
      urlIcon.src = "https://www.google.com/s2/favicons?sz=64&domain_url=https://chatgpt.com";
      claudeBatchSection?.classList.remove("hidden");
      if (batchSectionLabel) batchSectionLabel.textContent = "CHATGPT RECENTS";
    } else if (isGemini) {
      pageTitle.textContent = "Gemini - Chat";
      urlText.textContent = "https://gemini.google.com";
      urlIcon.src = "https://upload.wikimedia.org/wikipedia/commons/1/1d/Google_Gemini_icon_2025.svg";
      claudeBatchSection?.classList.remove("hidden");
      if (batchSectionLabel) batchSectionLabel.textContent = "GEMINI RECENTS";
      
      // Hide ZIP option for Gemini (no media files to package)
      const zipOption = document.querySelector('.option-item[data-value="zip"]');
      if (zipOption) {
        zipOption.style.display = 'none';
      }
    } else if (isClaude) {
      pageTitle.textContent = "Claude - Conversation";
      urlText.textContent = "https://claude.ai";
      urlIcon.src = "https://www.google.com/s2/favicons?sz=64&domain_url=https://claude.ai";
      claudeBatchSection?.classList.remove("hidden");
      if (batchSectionLabel) batchSectionLabel.textContent = "CLAUDE RECENTS";
      if (isClaudeRecents) {
        pageTitle.textContent = "Claude - Recents";
        copyBtn.disabled = true;
        downloadBtn.disabled = true;
        copyBtn.title = "Open a specific Claude chat to export a single conversation.";
        downloadBtn.title = "Open a specific Claude chat to export a single conversation.";
      }
    }
  });

  function updateStatus(message, type = "info") {
    statusArea.classList.remove("hidden");
    statusText.textContent = message;
    statusArea.style.backgroundColor = type === "error" ? "#fee2e2" : "#f3f4f6";
    statusText.style.color = type === "error" ? "#991b1b" : "#374151";
  }

  function toggleClaudeCustomLimit() {
    const isCustom = claudeBatchLimit?.value === "custom";
    claudeBatchCustomLimit?.classList.toggle("hidden", !isCustom);
  }

  function getClaudeBatchLimitValue() {
    if (claudeBatchLimit?.value !== "custom") {
      return Number(claudeBatchLimit?.value || 10);
    }

    const value = Number(claudeBatchCustomLimit?.value);
    if (!Number.isInteger(value) || value < 1 || value > 500) {
      updateStatus("Enter a custom count from 1 to 500.", "error");
      claudeBatchCustomLimit?.focus();
      return null;
    }

    return value;
  }

  function sendMessageToContentScript(action, payload = {}) {
    return new Promise((resolve, reject) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs.length === 0) {
          updateStatus("No active tab found.", "error");
          return;
        }

        chrome.tabs.sendMessage(
          tabs[0].id,
          { action, ...payload },
          (response) => {
            if (chrome.runtime.lastError) {
              const err = chrome.runtime.lastError.message;
              if (err.includes("Receiving end does not exist")) {
                // Content script might not be loaded. Try to inject it.
                updateStatus("Injecting scripts...", "info");

                const injectContentDependencies = () => {
                  chrome.scripting.executeScript(
                    {
                      target: { tabId: tabs[0].id },
                      files: [
                        "libs/jszip.min.js",
                        "template.js",
                        "gemini_exporter.js",
                        "content.js",
                      ],
                    },
                    () => {
                      if (chrome.runtime.lastError) {
                        console.error(
                          "Injection failed:",
                          chrome.runtime.lastError.message
                        );
                        updateStatus(
                          "Please refresh the page and try again.",
                          "error"
                        );
                        reject(chrome.runtime.lastError);
                      } else {
                        // Retry sending the message
                        chrome.tabs.sendMessage(
                          tabs[0].id,
                          { action, ...payload },
                          (retryResponse) => {
                            if (chrome.runtime.lastError) {
                              updateStatus(
                                "Connection failed. Please refresh.",
                                "error"
                              );
                              reject(chrome.runtime.lastError);
                            } else {
                              resolve(retryResponse);
                            }
                          }
                        );
                      }
                    }
                  );
                };

                if (tabs[0].url?.includes("aistudio.google.com")) {
                  chrome.scripting.executeScript(
                    {
                      target: { tabId: tabs[0].id },
                      files: ["aistudio_rpc_bridge.js"],
                      world: "MAIN",
                    },
                    () => {
                      if (chrome.runtime.lastError) {
                        console.info(
                          "AI Studio RPC bridge injection needs a page refresh:",
                          chrome.runtime.lastError.message
                        );
                      }
                      injectContentDependencies();
                    }
                  );
                } else {
                  injectContentDependencies();
                }
              } else {
                console.error(err);
                updateStatus(`Error: ${err}`, "error");
                reject(chrome.runtime.lastError);
              }
            } else {
              resolve(response);
            }
          }
        );
      });
    });
  }

  copyBtn.addEventListener("click", async () => {
    updateStatus("Scraping chat...");
    try {
      // Check if we're on Gemini
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const isGemini = tabs[0]?.url?.includes("gemini.google.com");
      
      if (isGemini) {
        // Set mode to 'copy' for Gemini
        await chrome.tabs.sendMessage(tabs[0].id, {
          action: "SET_EXPORT_MODE",
          mode: "copy"
        });
      }
      
      const action = isGemini ? "START_SCRAPE_GEMINI" : "START_SCRAPE";
      const response = await sendMessageToContentScript(action, {
        includeAttachments: includeAIStudioAttachments,
      });
      if (response && response.status === "started") {
        // The content script will send progress updates via runtime.onMessage
      }
    } catch (e) {
      // Error handled in sendMessageToContentScript
    }
  });

  downloadBtn.addEventListener("click", async () => {
    const format = document.getElementById("download-format").value;
    updateStatus(`Preparing ${format.toUpperCase()} download...`);
    try {
      // Check if we're on Gemini
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const isGemini = tabs[0]?.url?.includes("gemini.google.com");
      
      if (isGemini) {
        // Set mode to 'download' for Gemini
        await chrome.tabs.sendMessage(tabs[0].id, {
          action: "SET_EXPORT_MODE",
          mode: "download"
        });
      }
      
      const action = isGemini ? "START_SCRAPE_GEMINI" : "START_SCRAPE";
      const response = await sendMessageToContentScript(action, {
        download: true,
        format,
        mode: format === 'zip' ? 'full' : 'text', // ZIP uses full packaging mode
        includeAttachments: includeAIStudioAttachments,
      });
      if (response && response.status === "started") {
        // The content script will send progress updates
      }
    } catch (e) {
      // Error handled
    }
  });

  claudeBatchDownloadBtn?.addEventListener("click", async () => {
    const format = document.getElementById("download-format").value;
    const limit = getClaudeBatchLimitValue();
    if (!limit) return;

    const effectiveFormat = format === "zip" ? "markdown" : format;

    updateStatus(
      `Preparing recent ${limit} ${effectiveFormat.toUpperCase()} exports...`
    );

    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const url = tabs[0]?.url || "";
      const isGemini = url.includes("gemini.google.com");
      const action = isGemini
        ? "START_GEMINI_BATCH_EXPORT"
        : "START_PLATFORM_BATCH_EXPORT";

      const response = await sendMessageToContentScript(action, {
        download: true,
        format,
        limit,
      });

      if (response && response.status === "started") {
        // The content script will send progress updates.
      }
    } catch (e) {
      // Error handled in sendMessageToContentScript
    }
  });

  claudeBatchLimit?.addEventListener("change", toggleClaudeCustomLimit);
  toggleClaudeCustomLimit();

  // Custom Dropdown Logic
  const formatTrigger = document.getElementById("format-trigger");
  const formatOptions = document.getElementById("format-options");
  const formatInput = document.getElementById("download-format");
  const selectedFormatText = document.getElementById("selected-format-text");
  const optionItems = document.querySelectorAll(".option-item");

  // Toggle menu
  formatTrigger.addEventListener("click", (e) => {
    e.stopPropagation();
    formatOptions.classList.toggle("hidden");
  });

  // Close menu when clicking outside
  document.addEventListener("click", (e) => {
    if (!formatTrigger.contains(e.target) && !formatOptions.contains(e.target)) {
      formatOptions.classList.add("hidden");
    }
  });

  // Handle option selection
  optionItems.forEach(item => {
    item.addEventListener("click", () => {
      const value = item.dataset.value;
      const text = item.querySelector("span").textContent;
      
      // Update hidden input
      formatInput.value = value;
      
      // Update trigger text
      selectedFormatText.textContent = text;
      
      // Update UI selection state
      optionItems.forEach(opt => {
        opt.classList.remove("selected");
        opt.querySelector(".check-icon").classList.add("hidden");
      });
      item.classList.add("selected");
      item.querySelector(".check-icon").classList.remove("hidden");
      
      // Close menu
      formatOptions.classList.add("hidden");
    });
  });

  // Listen for messages from content script
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "UPDATE_STATUS") {
      updateStatus(message.message || message.status, message.type || "info");
    } else if (message.action === "SCRAPE_COMPLETE") {
      // For ZIP or direct HTML downloads, just show success message
      if (message.format === 'zip' || message.directDownload) {
        updateStatus('Download started!', 'success');
        setTimeout(() => statusArea.classList.add('hidden'), 3000);
        return;
      }
      
      // For other formats, handle download in popup
      updateStatus("Scraping complete!", "success");
      if (message.data) {
        if (message.copyToClipboard) {
          navigator.clipboard
            .writeText(message.data)
            .then(() => {
              updateStatus("Copied to clipboard!", "success");
              setTimeout(() => statusArea.classList.add("hidden"), 3000);
            })
            .catch((err) => {
              updateStatus("Failed to copy.", "error");
            });
        } else if (message.download) {
          // Trigger download
          const blob = new Blob([message.data], {
            type: "text/markdown;charset=utf-8",
          });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download =
            message.filename ||
            `export_${new Date()
              .toISOString()
              .slice(0, 19)
              .replace(/[:T]/g, "-")}.${
              message.format === "json" ? "json" : message.format === "text" ? "txt" : message.format === "html" ? "html" : "md"
            }`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          updateStatus("Download started!", "success");
          setTimeout(() => statusArea.classList.add("hidden"), 3000);
        }
      }
    } else if (message.action === "SCRAPE_ERROR") {
      updateStatus(`Error: ${message.error}`, "error");
    }
  });
});
