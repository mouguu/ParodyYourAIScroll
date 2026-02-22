/**
 * ChatGPT Token Extractor
 * Runs in MAIN world to access window.__remixContext
 */
(function() {
  'use strict';

  function deepClone(value) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (e) {
      return null;
    }
  }

  function looksLikeConversation(payload) {
    return !!(
      payload &&
      typeof payload === 'object' &&
      payload.mapping &&
      typeof payload.mapping === 'object'
    );
  }

  function unwrapConversation(candidate) {
    if (!candidate || typeof candidate !== 'object') return null;

    const directCandidates = [
      candidate,
      candidate.data,
      candidate.conversation,
      candidate.serverResponse?.data,
      candidate.props?.pageProps?.serverResponse?.data,
    ];

    for (const item of directCandidates) {
      if (looksLikeConversation(item)) {
        return deepClone(item);
      }
    }

    return null;
  }

  function extractConversation() {
    try {
      // NEXT_DATA
      const nextConversation = unwrapConversation(window.__NEXT_DATA__?.props?.pageProps);
      if (nextConversation) {
        console.log('[ChatGPT Data] Conversation found via NEXT_DATA');
        return nextConversation;
      }

      // Remix loaderData
      const loaderData = window.__remixContext?.state?.loaderData;
      if (loaderData && typeof loaderData === 'object') {
        for (const [routeKey, routeData] of Object.entries(loaderData)) {
          const found = unwrapConversation(routeData);
          if (found) {
            console.log('[ChatGPT Data] Conversation found via remix route:', routeKey);
            return found;
          }
        }
      }
    } catch (e) {
      console.error('[ChatGPT Data] Extraction error:', e);
    }

    return null;
  }
  
  function extractToken() {
    let token = null;
    
    try {
      // Method 1: remixContext -> clientBootstrap -> session (Most common)
      if (window.__remixContext?.state?.loaderData?.root?.clientBootstrap?.session?.accessToken) {
        token = window.__remixContext.state.loaderData.root.clientBootstrap.session.accessToken;
        console.log('[ChatGPT Token] Found via clientBootstrap.session');
        return token;
      }
      
      // Method 2: remixContext -> session (Alternative path)
      if (window.__remixContext?.state?.loaderData?.root?.session?.accessToken) {
        token = window.__remixContext.state.loaderData.root.session.accessToken;
        console.log('[ChatGPT Token] Found via root.session');
        return token;
      }
      
      // Method 3: Direct client-bootstrap script tag
      const bootstrapScript = document.getElementById('client-bootstrap');
      if (bootstrapScript) {
        try {
          const bootstrapData = JSON.parse(bootstrapScript.textContent);
          if (bootstrapData?.session?.accessToken) {
            token = bootstrapData.session.accessToken;
            console.log('[ChatGPT Token] Found via client-bootstrap script');
            return token;
          }
        } catch (e) {
          console.log('[ChatGPT Token] Failed to parse client-bootstrap:', e);
        }
      }
      
      // Method 4: NEXT_DATA (Legacy)
      if (window.__NEXT_DATA__?.props?.pageProps?.user?.accessToken) {
        token = window.__NEXT_DATA__.props.pageProps.user.accessToken;
        console.log('[ChatGPT Token] Found via NEXT_DATA');
        return token;
      }
      
      // Debug: Log available structures
      console.log('[ChatGPT Token] Available structures:', {
        hasRemixContext: !!window.__remixContext,
        hasNextData: !!window.__NEXT_DATA__,
        hasBootstrapScript: !!document.getElementById('client-bootstrap'),
        remixRoot: window.__remixContext?.state?.loaderData?.root ? Object.keys(window.__remixContext.state.loaderData.root) : null
      });
      
    } catch (e) {
      console.error('[ChatGPT Token] Extraction error:', e);
    }
    
    return token;
  }
  
  // Listen for requests from the content script
  window.addEventListener('message', function(event) {
    if (event.source !== window) return;
    if (!event.data || !event.data.type) return;

    if (event.data.type === 'CHATGPT_TOKEN_REQUEST') {
      const token = extractToken();
      
      // Send the token back to the content script
      window.postMessage({
        type: 'CHATGPT_TOKEN_RESULT',
        token: token
      }, '*');
    }

    if (event.data.type === 'CHATGPT_CONVERSATION_REQUEST') {
      const conversation = extractConversation();
      window.postMessage({
        type: 'CHATGPT_CONVERSATION_RESULT',
        conversation: conversation
      }, '*');
    }
  });
  
  console.log('[ChatGPT Token] Token extractor ready (v3)');
})();
