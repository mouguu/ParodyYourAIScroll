document.addEventListener("DOMContentLoaded", () => {
  const copyBtn = document.getElementById("copy-btn");
  const downloadBtn = document.getElementById("download-btn");
  const statusArea = document.getElementById("status-area");
  const statusText = document.getElementById("status-text");

  // Update Header Info based on current tab
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs.length === 0) return;
    
    const url = tabs[0].url;
    const isAIStudio = url && url.includes("aistudio.google.com");
    const isChatGPT = url && (url.includes("chatgpt.com") || url.includes("chat.openai.com"));

    const pageTitle = document.querySelector(".page-title");
    const urlText = document.querySelector(".url-text");
    const urlIcon = document.querySelector(".url-icon");

    if (isAIStudio) {
      pageTitle.textContent = "GoogleAIStudio - Playground";
      urlText.textContent = "https://aistudio.google.com";
      urlIcon.src = "https://www.gstatic.com/aistudio/ai_studio_favicon_2_32x32.png";
    } else if (isChatGPT) {
      pageTitle.textContent = "ChatGPT - Conversation";
      urlText.textContent = "https://chatgpt.com";
      urlIcon.src = "https://chatgpt.com/favicon.ico";
    }
  });

  function updateStatus(message, type = "info") {
    statusArea.classList.remove("hidden");
    statusText.textContent = message;
    statusArea.style.backgroundColor = type === "error" ? "#fee2e2" : "#f3f4f6";
    statusText.style.color = type === "error" ? "#991b1b" : "#374151";
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
                updateStatus("Injecting script...", "info");
                chrome.scripting.executeScript(
                  {
                    target: { tabId: tabs[0].id },
                    files: ["content.js"],
                  },
                  () => {
                    if (chrome.runtime.lastError) {
                      console.error("Injection failed:", chrome.runtime.lastError.message);
                      updateStatus("Failed to inject script. Please refresh page.", "error");
                      reject(chrome.runtime.lastError);
                    } else {
                      // Retry sending the message
                      chrome.tabs.sendMessage(
                        tabs[0].id,
                        { action, ...payload },
                        (retryResponse) => {
                          if (chrome.runtime.lastError) {
                            updateStatus("Connection failed after injection. Refresh?", "error");
                            reject(chrome.runtime.lastError);
                          } else {
                            resolve(retryResponse);
                          }
                        }
                      );
                    }
                  }
                );
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
      const response = await sendMessageToContentScript("START_SCRAPE");
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
      const response = await sendMessageToContentScript("START_SCRAPE", {
        download: true,
        format,
      });
      if (response && response.status === "started") {
        // The content script will send progress updates
      }
    } catch (e) {
      // Error handled
    }
  });

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
      updateStatus(message.status, "info"); // Fixed: message.status instead of message.message
    } else if (message.action === "SCRAPE_COMPLETE") {
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
          a.download = `export_${new Date()
            .toISOString()
            .slice(0, 19)
            .replace(/[:T]/g, "-")}.${
            message.format === "json" ? "json" : "md"
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
