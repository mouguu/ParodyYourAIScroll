/**
 * ChatGPT Token Extractor
 * Runs in MAIN world to access window.__remixContext
 */
(function() {
  'use strict';
  
  // Listen for token requests from the content script
  window.addEventListener('message', function(event) {
    if (event.source !== window) return;
    if (event.data && event.data.type === 'CHATGPT_TOKEN_REQUEST') {
      let token = null;
      
      try {
        // Try remixContext (New Remix-based ChatGPT)
        if (window.__remixContext) {
          const ctx = window.__remixContext;
          token = ctx?.state?.loaderData?.root?.session?.accessToken ||
                  ctx?.state?.loaderData?.root?.clientBootstrap?.session?.accessToken;
        }
        
        // Try NEXT_DATA (Older Next.js-based ChatGPT)
        if (!token && window.__NEXT_DATA__) {
          token = window.__NEXT_DATA__?.props?.pageProps?.user?.accessToken;
        }
      } catch (e) {
        console.error('[ChatGPT Token] Extraction error:', e);
      }
      
      // Send the token back to the content script
      window.postMessage({
        type: 'CHATGPT_TOKEN_RESULT',
        token: token
      }, '*');
    }
  });
  
  console.log('[ChatGPT Token] Token extractor ready');
})();
