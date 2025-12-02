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
