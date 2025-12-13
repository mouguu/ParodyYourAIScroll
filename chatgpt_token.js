/**
 * ChatGPT Token Extractor
 * Runs in MAIN world to access window.__remixContext
 */
(function() {
  'use strict';
  
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
  
  // Listen for token requests from the content script
  window.addEventListener('message', function(event) {
    if (event.source !== window) return;
    if (event.data && event.data.type === 'CHATGPT_TOKEN_REQUEST') {
      const token = extractToken();
      
      // Send the token back to the content script
      window.postMessage({
        type: 'CHATGPT_TOKEN_RESULT',
        token: token
      }, '*');
    }
  });
  
  console.log('[ChatGPT Token] Token extractor ready (v2)');
})();
