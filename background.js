// Background script to switch between supported and unsupported popups

function updatePopup(tabId, url) {
  if (!url) return;

  const isAIStudio = url.includes("aistudio.google.com");
  const isChatGPT = url.includes("chatgpt.com") || url.includes("chat.openai.com");

  if (isAIStudio || isChatGPT) {
    chrome.action.setPopup({ tabId: tabId, popup: "supported.html" });
  } else {
    chrome.action.setPopup({ tabId: tabId, popup: "unsupported.html" });
  }
}

// Initialize on extension install/update
chrome.runtime.onInstalled.addListener(() => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0] && tabs[0].url) {
      updatePopup(tabs[0].id, tabs[0].url);
    }
  });
});

// Initialize when extension icon is clicked
chrome.action.onClicked.addListener((tab) => {
  if (tab.url) {
    updatePopup(tab.id, tab.url);
  }
});

// Listen for tab updates
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    updatePopup(tabId, tab.url);
  }
});

// Listen for tab activation
chrome.tabs.onActivated.addListener((activeInfo) => {
  chrome.tabs.get(activeInfo.tabId, (tab) => {
    if (tab.url) {
      updatePopup(activeInfo.tabId, tab.url);
    }
  });
});

// Handle download requests from content script
// Chunked download storage
let downloadChunks = {};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "DOWNLOAD_BLOB") {
    // Legacy single-message handler (keep for small files if needed, or remove)
    chrome.downloads.download({
      url: request.url,
      filename: request.filename,
      saveAs: true
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ success: true, downloadId: downloadId });
      }
    });
    return true; // Keep channel open
  }
  
  if (request.action === "DOWNLOAD_CHUNK") {
    const { fileId, chunk, index, total } = request;
    if (!downloadChunks[fileId]) {
      downloadChunks[fileId] = new Array(total);
    }
    downloadChunks[fileId][index] = chunk;
    sendResponse({ success: true });
    return false;
  }
  
  if (request.action === "DOWNLOAD_FINISH") {
    const { fileId, filename } = request;
    const chunks = downloadChunks[fileId];
    
    if (!chunks || chunks.some(c => !c)) {
      sendResponse({ success: false, error: "Missing chunks" });
      delete downloadChunks[fileId];
      return false;
    }
    
    // Reassemble Base64 string
    const base64Data = chunks.join('');
    
    chrome.downloads.download({
      url: base64Data,
      filename: filename,
      saveAs: true
    }, (downloadId) => {
      // Cleanup
      delete downloadChunks[fileId];
      
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ success: true, downloadId: downloadId });
      }
    });
    return true;
  }
});
