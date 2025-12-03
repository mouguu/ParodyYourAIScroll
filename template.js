// HTML Template for AI Chat Export
// Design Style: Neo-Brutalism (BentoML inspired)

function getHTMLTemplate(title, date, content) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
    <style>
        :root {
            /* Palette - Refined */
            --bg-body: #F5F5F7; 
            --bg-card: #FFFFFF;
            --bg-editor: #0E0E0E; /* Deep almost-black */
            
            --text-primary: #18181B; 
            --text-secondary: #71717A;
            --text-tertiary: #A1A1AA;
            
            /* The "Cursor" Blue/Purple tint for highlights */
            --accent-glow-color: rgba(59, 130, 246, 0.15); 
            
            --border-light: rgba(0, 0, 0, 0.04);
            --border-medium: rgba(0, 0, 0, 0.08);
            
            --radius-xl: 20px;
            --radius-lg: 12px;
            --radius-sm: 6px;
            
            --font-sans: 'Inter', system-ui, -apple-system, sans-serif;
            --font-mono: 'JetBrains Mono', 'Menlo', monospace;
        }
        
        * { box-sizing: border-box; }
        
        body { 
            font-family: var(--font-sans);
            background-color: var(--bg-body);
            color: var(--text-primary);
            line-height: 1.65;
            margin: 0;
            padding: 80px 20px;
            -webkit-font-smoothing: antialiased;
            -moz-osx-font-smoothing: grayscale;
            
            /* Ambient Light Effect (The "Expensive" feel) */
            background-image: 
                radial-gradient(circle at 50% 0%, rgba(255,255,255,0.8) 0%, rgba(255,255,255,0) 50%),
                radial-gradient(circle at 85% 20%, rgba(200, 210, 255, 0.2) 0%, rgba(0,0,0,0) 30%);
            background-attachment: fixed;
        }

        .container {
            max-width: 760px;
            margin: 0 auto;
        }

        /* HEADER: Elegant & Centered */
        .header { 
            text-align: center;
            margin-bottom: 80px;
            position: relative;
        }
        
        .header-meta {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            background: rgba(255,255,255,0.6);
            backdrop-filter: blur(10px);
            border: 1px solid var(--border-medium);
            padding: 6px 12px;
            border-radius: 100px;
            font-size: 12px;
            font-weight: 500;
            color: var(--text-secondary);
            margin-bottom: 24px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.03);
        }

        .header h1 { 
            font-size: 42px; 
            font-weight: 600; 
            letter-spacing: -0.03em;
            line-height: 1.1;
            margin: 0 0 16px 0;
            color: #000;
        }

        /* TURNS: The "Cards" */
        .turn { 
            margin-bottom: 40px;
            animation: fadeIn 0.5s ease-out forwards;
            opacity: 0;
        }
        
        @keyframes fadeIn {
            to { opacity: 1; transform: translateY(0); }
            from { opacity: 0; transform: translateY(10px); }
        }

        .role-label {
            font-size: 11px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            color: var(--text-tertiary);
            margin-bottom: 12px;
            margin-left: 4px;
            display: flex;
            align-items: center;
            gap: 6px;
        }
        
        .role-label::before {
            content: '';
            display: block;
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: currentColor;
            opacity: 0.5;
        }

        /* USER BUBBLE: Minimalist Glass */
        .user-card { 
            background: rgba(255, 255, 255, 0.8);
            border: 1px solid rgba(0,0,0,0.05);
            border-radius: var(--radius-xl);
            padding: 24px 32px;
            box-shadow: 
                0 4px 6px -1px rgba(0, 0, 0, 0.02), 
                0 2px 4px -1px rgba(0, 0, 0, 0.02),
                inset 0 0 0 1px rgba(255,255,255,0.5); /* Inner highlight */
            font-size: 16px;
            color: #111;
        }

        /* MODEL BUBBLE: The "IDE" Look */
        .model-card { 
            position: relative;
            background: var(--bg-editor);
            color: #E2E2E2;
            border-radius: var(--radius-xl);
            padding: 0; /* Padding handled by internal containers */
            overflow: hidden;
            box-shadow: 
                0 20px 25px -5px rgba(0, 0, 0, 0.1), 
                0 10px 10px -5px rgba(0, 0, 0, 0.04),
                0 0 0 1px rgba(0,0,0,0.08);
        }
        
        /* Simulating the MacOS window header on the model card */
        .model-header {
            background: #1A1A1A;
            padding: 10px 16px;
            display: flex;
            gap: 6px;
            border-bottom: 1px solid #2A2A2A;
        }
        .dot { width: 10px; height: 10px; border-radius: 50%; }
        .dot.red { background: #FF5F56; }
        .dot.yellow { background: #FFBD2E; }
        .dot.green { background: #27C93F; }

        .model-content {
            padding: 32px;
            font-size: 15px;
            line-height: 1.7;
        }

        /* THINKING BLOCK: The "Terminal" Style */
        .thinking { 
            margin: 0 0 24px 0;
            border-bottom: 1px solid #2A2A2A;
            background: #111;
        }
        
        .thinking-header {
            padding: 12px 20px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: space-between;
            color: #666;
            font-family: var(--font-mono);
            font-size: 12px;
            transition: color 0.2s;
            user-select: none;
        }
        .thinking-header:hover { color: #888; }
        
        .thinking-title { display: flex; align-items: center; gap: 8px; }
        .thinking-title::before { content: '>'; font-weight: bold; }
        
        .thinking-content {
            max-height: 0;
            overflow: hidden;
            transition: max-height 0.4s cubic-bezier(0.16, 1, 0.3, 1);
            background: #000;
            color: #555;
            font-family: var(--font-mono);
            font-size: 12px;
            padding: 0 20px;
            white-space: pre-wrap;
        }
        .thinking-content.expanded {
            max-height: 800px;
            padding: 16px 20px 24px 20px;
        }

        /* MARKDOWN STYLES within Model */
        .model-content strong { color: #FFF; font-weight: 600; }
        .model-content a { color: #60A5FA; text-decoration: none; border-bottom: 1px solid rgba(96, 165, 250, 0.4); }
        
        /* Code Blocks */
        .model-content pre {
            background: #181818;
            border: 1px solid #2A2A2A;
            border-radius: var(--radius-lg);
            padding: 16px;
            overflow-x: auto;
            font-family: var(--font-mono);
            font-size: 13px;
            color: #A9B7C6;
            margin: 20px 0;
        }
        
        .model-content code {
            font-family: var(--font-mono);
            background: rgba(255,255,255,0.1);
            padding: 2px 4px;
            border-radius: 4px;
            font-size: 0.9em;
        }
        .model-content pre code {
            background: transparent;
            padding: 0;
        }

        /* Media Containers */
        .media-container {
            margin: 20px 0;
            display: flex;
            flex-direction: column;
            gap: 16px;
        }
        
        .media-container img, 
        .media-container video {
            max-width: 100%;
            height: auto;
            border-radius: var(--radius-lg);
            border: 1px solid var(--border-medium);
            display: block;
        }
        
        /* Specific fix for user card media to blend in */
        .user-card .media-container img,
        .user-card .media-container video {
            border: 1px solid rgba(0,0,0,0.1);
            box-shadow: 0 4px 12px rgba(0,0,0,0.05);
        }

    </style>
    <script>
        function toggleThinking(header) {
            const content = header.nextElementSibling;
            const arrow = header.querySelector('.arrow');
            if (content.classList.contains('expanded')) {
                content.classList.remove('expanded');
                if(arrow) arrow.innerHTML = '↓';
            } else {
                content.classList.add('expanded');
                if(arrow) arrow.innerHTML = '↑';
            }
        }
    </script>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="header-meta">
                <span>Cursor Chat Export</span>
                <span style="opacity:0.3">|</span>
                <span>${date}</span>
            </div>
            <h1>${title}</h1>
        </div>
        ${content}
    </div>
</body>
</html>`;
}

// Explicitly export to window to ensure visibility to other content scripts
window.getHTMLTemplate = getHTMLTemplate;
