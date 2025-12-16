// ==UserScript==
// @name           Live Gmail Panel
// @description    Displays Gmail inbox emails in a floating panel when hovering over Gmail essential tabs
// @author         Bxth
// @version        2.1
// @namespace      https://github.com/zen-browser/desktop
// ==/UserScript==

(function() {
  'use strict';


  // Configuration
  const CONFIG = {
    GMAIL_URL_PREF: 'live-gmail.url',
    DEBUG_PREF: 'live-gmail.debug',
    DEFAULT_GMAIL_URL: 'mail.google.com',
    MAX_EMAILS: 20,
    PANEL_ID: 'live-gmail-panel',
    PANEL_HIDDEN_CLASS: 'live-gmail-hidden'
  };

  /**
   * Check if debug logging is enabled
   */
  function isDebugEnabled() {
    try {
      if (typeof Services !== 'undefined' && Services.prefs) {
        return Services.prefs.getBoolPref(CONFIG.DEBUG_PREF, false);
      }
    } catch (e) {}
    return false;
  }

  /**
   * Debug log function (only logs if DEBUG_PREF is enabled)
   */
  function debugLog(...args) {
    if (isDebugEnabled()) {
      console.log('[Live Gmail]', ...args);
    }
  }

  // State
  let currentEmails = [];
  let cachedEmails = []; // Lightweight in-memory cache for when tab is closed
  let hoveredTab = null;
  let panelElement = null;
  let gmailTabs = new Map();
  let clickedEmailIds = new Set();
  let messageListenersRegistered = false;
  let lastScanRequestTs = 0;
  let lastLogTs = 0;


  /**
   * Check if a tab is a Gmail essential tab
   */
  function isGmailEssentialTab(tab) {
    if (!tab || !tab.hasAttribute('zen-essential')) return false;

    // Respect container-specific essentials: ignore essentials from other containers
    try {
      if (window.gZenWorkspaces && gZenWorkspaces.containerSpecificEssentials) {
        const active = gZenWorkspaces.getActiveWorkspaceFromCache();
        const activeContainerId = active?.containerTabId || 0;
        const tabContainerId = parseInt(tab.getAttribute('usercontextid') || 0, 10);
        if (activeContainerId && tabContainerId !== activeContainerId) {
          return false;
        }
      }
    } catch (e) {}

    const pattern = getGmailUrlPattern();
    const dataUrl = tab.getAttribute('data-url') || '';
    
    if (dataUrl.includes(pattern)) return true;
    
    if (tab.linkedBrowser && tab.linkedBrowser.currentURI) {
      try {
        const tabUrl = tab.linkedBrowser.currentURI.spec;
        if (tabUrl && tabUrl.includes(pattern)) return true;
      } catch (e) {}
    }
    
    return false;
  }


  // ============================================
  // Frame Script for Gmail DOM Parsing
  // ============================================
  
  /**
   * The content script that runs in Gmail tabs to parse the inbox DOM.
   * This is injected via messageManager.loadFrameScript as a data: URL.
   */
  const GMAIL_FRAME_SCRIPT = `
(function() {
  'use strict';
  
  const MAX_EMAILS = 20;
  const SCAN_DEBOUNCE_MS = 300;
  let scanTimeout = null;
  let observer = null;
  let lastScanResult = null;
  let lastDebugLog = 0;
  const DEBUG_INTERVAL_MS = 5000;
  
  // Debug logging function (controlled by parent via message)
  let DEBUG_ENABLED = false;
  function frameDebugLog(...args) {
    if (DEBUG_ENABLED) {
      content.console.log('[Live Gmail Frame]', ...args);
    }
  }
  
  frameDebugLog('Script loaded on', content.location.href);
  
  /**
   * Check if current page is Gmail inbox
   */
  function isGmailInbox() {
    return content.location.href.includes('mail.google.com');
  }
  
  /**
   * Extract thread ID from a Gmail row element
   */
  function extractThreadId(row) {
    const attrs = ['data-legacy-thread-id', 'data-thread-id', 'data-legacy-message-id', 
                   'data-message-id', 'data-id', 'data-uid', 'data-internalid'];
    for (const attr of attrs) {
      const val = row.getAttribute(attr);
      if (val) return val;
    }
    
    // Try to find link with thread hash
    const links = row.querySelectorAll('a[href*="#inbox/"], a[href*="#all/"], a[href*="#sent/"]');
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      const match = href.match(/#(?:inbox|all|sent|starred|label)\\/([a-zA-Z0-9]+)/);
      if (match && match[1]) return match[1];
    }
    
    if (row.id && row.id.length > 5) return row.id;
    return null;
  }

  /**
   * Extract a Gmail URL/hash from a row
   */
  function extractGmailUrl(row) {
    if (row.tagName === 'A' && row.href) return row.href;
    
    const link = row.querySelector('a[href*="#inbox/"], a[href*="#all/"], a[href*="#sent/"], a[href*="#label/"]');
    if (link) return link.href || link.getAttribute('href') || '';
    
    const anyLink = row.querySelector('a[href*="#"]');
    if (anyLink) return anyLink.getAttribute('href') || '';
    return '';
  }
  
  /**
   * Check if a row represents an unread email
   */
  function isUnread(row) {
    const cls = row.classList;
    if (cls.contains('zE')) return true;
    if (cls.contains('unread')) return true;
    if (cls.contains('yO')) return false;
    if (row.getAttribute('data-is-read') === 'false') return true;

    const ariaLabel = (row.getAttribute('aria-label') || '').toLowerCase();
    if (ariaLabel.includes('unread') || ariaLabel.includes('non lu') || 
        ariaLabel.includes('no leído') || ariaLabel.includes('nicht gelesen')) return true;

    const boldElements = row.querySelectorAll('b, strong');
    if (boldElements.length > 0) return true;

    const senderSpan = row.querySelector('span[email], span.yP, span.zF, span.bA4 span, td.yX span');
    if (senderSpan) {
      try {
        const fontWeight = content.getComputedStyle(senderSpan).fontWeight;
        if (fontWeight === 'bold' || parseInt(fontWeight, 10) >= 600) return true;
      } catch(e) {}
    }

    return false;
  }
  
  /**
   * Extract sender name from row
   */
  function extractSender(row) {
    const emailSpan = row.querySelector('span[email]');
    if (emailSpan) return emailSpan.getAttribute('name') || emailSpan.textContent.trim();
    
    const selectors = ['td.yX span.yP', 'td.yX span.zF', 'span.bA4 span', 'td.xY span'];
    for (const sel of selectors) {
      const el = row.querySelector(sel);
      if (el && el.textContent.trim()) return el.textContent.trim();
    }
    
    const bold = row.querySelector('b, strong');
    if (bold && bold.textContent.trim()) return bold.textContent.trim();
    return 'Unknown';
  }
  
  /**
   * Extract subject from row
   */
  function extractSubject(row) {
    const selectors = ['span.bog', 'span.bqe', 'td.xY span.y2'];
    for (const sel of selectors) {
      const el = row.querySelector(sel);
      if (el && el.textContent.trim()) return el.textContent.trim();
    }
    return '(No subject)';
  }
  
  /**
   * Extract snippet from row
   */
  function extractSnippet(row) {
    const selectors = ['span.y2', 'span.Zt'];
    for (const sel of selectors) {
      const el = row.querySelector(sel);
      if (el && el.textContent.trim()) {
        let text = el.textContent.trim();
        if (text.startsWith('-')) text = text.substring(1).trim();
        return text.substring(0, 200);
      }
    }
    return '';
  }
  
  /**
   * Extract date from row - prefer short text content over full title
   */
  function extractDate(row) {
    const selectors = ['td.xW span', 'span.bq3', 'td:last-child span', 'span[title]'];
    for (const sel of selectors) {
      const el = row.querySelector(sel);
      if (el) {
        // Prefer the visible text content (usually short like "Dec 5" or "10:30")
        const text = el.textContent.trim();
        if (text && text.length < 20) return text;
      }
    }
    return '';
  }
  
  /**
   * Find email rows in the inbox
   */
  function findEmailRows() {
    const rowSelectors = [
      'tr.zA',
      'tr[role="row"]',
      'div[role="row"]',
      '[data-legacy-thread-id]',
      '[data-thread-id]',
      'div.Cp tr',
      'div[role="main"] tr'
    ];
    
    for (const selector of rowSelectors) {
      const rows = content.document.querySelectorAll(selector);
      if (rows.length > 0) return Array.from(rows);
    }
    
    const links = content.document.querySelectorAll('a[href*="#inbox/"], a[href*="#all/"]');
    if (links.length > 0) return Array.from(links);
    return [];
  }
  
  /**
   * Scan inbox DOM and extract unread emails
   */
  function scanInbox() {
    if (!isGmailInbox()) return null;
    
    const rows = findEmailRows();
    const threads = [];
    let unreadCount = 0;
    let rowIndex = 0;
    
    for (const row of rows) {
      rowIndex++;
      if (threads.length >= MAX_EMAILS) break;
      if (!isUnread(row)) continue;
      unreadCount++;
      
      const gmailUrl = extractGmailUrl(row);
      let threadId = extractThreadId(row);
      
      if (!threadId && gmailUrl) {
        const match = gmailUrl.match(/#(?:inbox|all|sent|starred|label)\\/([^/?#]+)/i);
        if (match && match[1]) threadId = match[1];
      }
      
      const sender = extractSender(row);
      const subject = extractSubject(row);
      const date = extractDate(row);
      
      // Generate stable fallback ID based on content (not position)
      if (!threadId) {
        // Simple hash of sender + subject + date for stable identification
        const contentStr = sender + '|' + subject + '|' + date;
        let hash = 0;
        for (let i = 0; i < contentStr.length; i++) {
          hash = ((hash << 5) - hash) + contentStr.charCodeAt(i);
          hash = hash & hash; // Convert to 32bit integer
        }
        threadId = 'hash-' + Math.abs(hash).toString(36);
      }
      
      threads.push({
        id: threadId,
        threadId: threadId,
        from: sender,
        subject: subject,
        snippet: extractSnippet(row),
        date: date,
        isUnread: true,
        url: gmailUrl,
        rowIndex: threads.length // Store index for clicking
      });
    }
    
    const now = Date.now();
    if (now - lastDebugLog > DEBUG_INTERVAL_MS) {
      lastDebugLog = now;
      frameDebugLog('rows=', rows.length, 'unread=', unreadCount, 'threads=', threads.length);
    }
    
    return { threads, timestamp: Date.now(), meta: { rows: rows.length, unread: unreadCount } };
  }
  
  /**
   * Debounced scan that sends results to parent
   */
  function debouncedScan() {
    if (scanTimeout) content.clearTimeout(scanTimeout);
    scanTimeout = content.setTimeout(() => {
      const result = scanInbox();
      if (result) {
        const resultStr = JSON.stringify(result.threads);
        if (resultStr !== lastScanResult) {
          lastScanResult = resultStr;
          sendAsyncMessage('LiveGmail:UnreadData', result);
        }
      }
    }, SCAN_DEBOUNCE_MS);
  }
  
  /**
   * Set up mutation observer
   */
  function setupObserver() {
    if (observer) observer.disconnect();
    
    const target = content.document.querySelector('div[role="main"]') || 
                   content.document.querySelector('div.Cp') || 
                   content.document.body;
    
    if (!target) {
      content.setTimeout(setupObserver, 1000);
      return;
    }
    
    observer = new content.MutationObserver(() => debouncedScan());
    observer.observe(target, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  }
  
  // Message handlers
  addMessageListener('LiveGmail:RequestScan', () => {
    frameDebugLog('Received RequestScan');
    const result = scanInbox();
    if (result) {
      lastScanResult = JSON.stringify(result.threads);
      sendAsyncMessage('LiveGmail:UnreadData', result);
    }
  });
  
  addMessageListener('LiveGmail:CheckReady', () => {
    // Check if Gmail inbox is ready (has email rows)
    const rows = findEmailRows();
    const isReady = rows.length > 0 || content.document.querySelector('div[role="main"]') !== null;
    sendAsyncMessage('LiveGmail:ReadyStatus', { ready: isReady, rows: rows.length });
  });
  
  addMessageListener('LiveGmail:OpenThread', (message) => {
    try {
      const data = message && message.data ? message.data : {};
      const rowIndex = data.rowIndex;
      const targetUrl = data.url || '';
      frameDebugLog('OpenThread', data);
      
      // Try to click the row by index first (most reliable for Gmail SPA)
      if (rowIndex !== undefined && rowIndex !== null) {
        const rows = findEmailRows();
        let unreadIdx = 0;
        for (const row of rows) {
          if (isUnread(row)) {
            if (unreadIdx === rowIndex) {
              frameDebugLog('Clicking row at index', rowIndex);
              // Try to find and click a link in the row
              const link = row.querySelector('a[href*="#"], a[role="link"]') || row.querySelector('a');
              if (link) {
                link.click();
                return;
              }
              // Fallback: click the row itself
              row.click();
              return;
            }
            unreadIdx++;
          }
        }
      }
      
      // Fallback: navigate via URL (only if it's a real Gmail URL, not a fallback)
      if (targetUrl && !targetUrl.includes('idx-') && !targetUrl.includes('row-') && !targetUrl.includes('hash-')) {
        if (/^https?:/i.test(targetUrl)) {
          content.location.href = targetUrl;
        } else if (targetUrl.startsWith('#')) {
          content.location.hash = targetUrl;
      } else {
          content.location.href = 'https://mail.google.com/mail/u/0/' + targetUrl;
        }
      }
    } catch (e) {
      content.console.warn('[Live Gmail Frame] OpenThread failed:', e);
    }
  });
  
  // Initialize
  function init() {
    frameDebugLog('Initializing...');
    if (content.document.readyState === 'complete') {
      setupObserver();
      debouncedScan();
    } else {
      content.addEventListener('load', () => {
        setupObserver();
        debouncedScan();
      });
    }
  }
  
  // Listen for debug enable/disable
  addMessageListener('LiveGmail:SetDebug', (message) => {
    DEBUG_ENABLED = message && message.data ? message.data.enabled : false;
  });
  
  if (content.location.href.includes('mail.google.com')) {
    init();
  }
})();
`;

  /**
   * Load the frame script into a browser
   */
  function loadFrameScript(browser) {
    if (!browser || !browser.messageManager) {
      debugLog('Cannot load frame script: no messageManager');
      return false;
    }
    
    try {
      const scriptDataUrl = 'data:application/javascript;charset=utf-8,' + encodeURIComponent(GMAIL_FRAME_SCRIPT);
      browser.messageManager.loadFrameScript(scriptDataUrl, true);
      
      // Send debug state to frame script immediately
      try {
        browser.messageManager.sendAsyncMessage('LiveGmail:SetDebug', {
          enabled: isDebugEnabled()
        });
      } catch (e) {}
      
      debugLog('Frame script loaded into tab');
      return true;
    } catch (e) {
      console.error('[Live Gmail] Error loading frame script:', e);
      return false;
    }
  }

  /**
   * Set up message listeners
   */
  function setupMessageListeners() {
    if (messageListenersRegistered) return;
    
    try {
      const globalMM = Services.mm;
      if (!globalMM) {
        console.warn('[Live Gmail] Global message manager not available');
        return;
      }
      
      globalMM.addMessageListener('LiveGmail:UnreadData', (message) => {
        try {
          handleFrameScriptData(message.data);
        } catch (e) {
          console.error('[Live Gmail] Error handling frame script data:', e);
        }
      });
      
      messageListenersRegistered = true;
      debugLog('Message listeners registered');
    } catch (e) {
      console.error('[Live Gmail] Error setting up message listeners:', e);
    }
  }

  /**
   * Request a scan from all Gmail tabs
   */
  function requestScanFromGmailTabs() {
    try {
    if (!gBrowser || !gBrowser.tabs) {
        debugLog('No gBrowser.tabs available');
      return;
    }

      // Throttle scan requests to avoid spamming (e.g., from frequent hovers)
      const now = Date.now();
      if (now - lastScanRequestTs < 4000) {
        return;
      }
      lastScanRequestTs = now;

    const gmailUrlPattern = getGmailUrlPattern();
      let foundGmailTabs = 0;
    
    for (const tab of gBrowser.tabs) {
        const browser = tab.linkedBrowser;
        if (!browser) continue;

      let tabUrl = '';
      try {
          if (browser.currentURI) {
            tabUrl = browser.currentURI.spec;
        }
      } catch (e) {
          continue;
      }

      if (tabUrl && tabUrl.includes(gmailUrlPattern)) {
          foundGmailTabs++;
          debugLog('Found Gmail tab:', tabUrl);
          
          // Load frame script
          loadFrameScript(browser);
          
          // Request scan
          try {
            if (browser.messageManager) {
              browser.messageManager.sendAsyncMessage('LiveGmail:RequestScan', {});
              debugLog('Sent RequestScan to tab');
      }
    } catch (e) {
            console.warn('[Live Gmail] Could not send RequestScan:', e);
          }
        }
      }
      
      debugLog('Found', foundGmailTabs, 'Gmail tabs');
    } catch (e) {
      console.warn('[Live Gmail] Error requesting scan:', e);
    }
  }

  /**
   * Handle data from frame script
   */
  function handleFrameScriptData(payload) {
    if (!payload || !Array.isArray(payload.threads)) return;

    // Throttle noisy logs
    const now = Date.now();
    if (payload.meta && now - lastLogTs > 10000) {
      lastLogTs = now;
      debugLog('Frame meta rows=', payload.meta.rows, 'unread=', payload.meta.unread);
      debugLog('Received', payload.threads.length, 'threads from frame');
    }

    // Map threads - keep only essential fields for memory efficiency
    const allEmails = payload.threads.slice(0, CONFIG.MAX_EMAILS).map((thread, idx) => ({
      id: thread.id || thread.threadId || '',
      threadId: thread.threadId || thread.id || '',
      from: thread.from || 'Unknown',
      subject: thread.subject || '(No subject)',
      date: thread.date || '',
      snippet: (thread.snippet || '').substring(0, 100), // Trim snippet for memory
      isUnread: thread.isUnread !== false,
      url: thread.url || '',
      rowIndex: thread.rowIndex !== undefined ? thread.rowIndex : idx
    }));
    
    // Filter out emails that were clicked (they may not be marked as read yet in Gmail)
    const nextEmails = allEmails.filter(email => !clickedEmailIds.has(email.id));

    // Update current emails
    currentEmails = nextEmails;
    
    // Update cache if we have data (lightweight in-memory cache)
    if (nextEmails.length > 0) {
      cachedEmails = nextEmails.slice();
    }
    
    // Clean up clickedEmailIds: if an email is no longer in the unread list, remove it from tracking
    const currentIds = new Set(allEmails.map(e => e.id));
    for (const clickedId of clickedEmailIds) {
      if (!currentIds.has(clickedId)) {
        clickedEmailIds.delete(clickedId);
      }
    }

    hideError();
    updateEmailDisplay();
  }

  /**
   * Initialize DOM mode
   */
  function initDomMode() {
    debugLog('Initializing DOM mode');
    setupMessageListeners();
    requestScanFromGmailTabs();
    
    // Periodic refresh - REMOVED as MutationObserver handles updates
    // setInterval(() => {
    //   requestScanFromGmailTabs();
    // }, 30000);
    
    return true;
  }

  /**
   * Patch ZenPinnedTabManager to prevent unloading of Gmail essential tabs
   */
  function patchZenPinnedTabManager() {
    if (!window.gZenPinnedTabManager) {
      debugLog('ZenPinnedTabManager not ready, retrying in 1s');
      setTimeout(patchZenPinnedTabManager, 1000);
      return;
    }

    if (window.gZenPinnedTabManager._liveGmailPatched) {
      return;
    }

    debugLog('Patching ZenPinnedTabManager.onCloseTabShortcut');
    
    // Save original function
    const originalOnClose = window.gZenPinnedTabManager.onCloseTabShortcut.bind(window.gZenPinnedTabManager);

    // Overwrite with our wrapper
    window.gZenPinnedTabManager.onCloseTabShortcut = async function(event, selectedTab, options = {}) {
      try {
        // Normalize input tabs (logic copied from ZenPinnedTabManager)
        const tabs = Array.isArray(selectedTab) ? selectedTab : [selectedTab || gBrowser.selectedTab];
        
        // Expand split views and filter pinned tabs
        const allTargetTabs = [
          ...new Set(
            tabs
              .flatMap((tab) => {
                if (tab && tab.group && tab.group.hasAttribute('split-view-group')) {
                  // If it's a split view group, get all tabs inside
                  return Array.from(tab.group.tabs || []);
                }
                return tab;
              })
              .filter((tab) => tab && tab.pinned)
          ),
        ];

        if (allTargetTabs.length === 0) {
          return await originalOnClose(event, selectedTab, options);
        }

        const gmailTabs = [];
        const otherTabs = [];

        for (const tab of allTargetTabs) {
          if (isGmailEssentialTab(tab)) {
            gmailTabs.push(tab);
          } else {
            otherTabs.push(tab);
          }
        }

        // 1. Handle non-Gmail tabs normally
        if (otherTabs.length > 0) {
          // We pass the specific array of other tabs to avoid re-processing Gmail tabs
          await originalOnClose(event, otherTabs, options);
        }

        // 2. Handle Gmail tabs (prevent unload)
        if (gmailTabs.length > 0) {
          debugLog('Intercepted close/unload for ' + gmailTabs.length + ' Gmail tabs');
          
          if (event) {
            try {
              event.stopPropagation();
              event.preventDefault();
            } catch(e) {}
          }

          // If any Gmail tab is selected, switch away from it
          const selectedGmailTabs = gmailTabs.filter(t => t.selected);
          if (selectedGmailTabs.length > 0) {
            if (this._handleTabSwitch) {
              this._handleTabSwitch(selectedGmailTabs[0]);
            } else {
              // Fallback if _handleTabSwitch is not available
              gBrowser.tabContainer.advanceSelectedTab(1, true);
            }
          }
          
          // CRITICAL: We do NOT call unload or removeTab for these tabs.
          // They remain loaded in the background.
        }
      } catch (e) {
        console.error('[Live Gmail] Error in patched onCloseTabShortcut:', e);
        // Fallback to original if something goes wrong
        return await originalOnClose(event, selectedTab, options);
      }
    };

    window.gZenPinnedTabManager._liveGmailPatched = true;
    debugLog('ZenPinnedTabManager successfully patched');
  }

  /**
   * Create the floating panel
   */
  function createPanel() {
    if (panelElement) return;

    panelElement = document.createElement('div');
    panelElement.id = CONFIG.PANEL_ID;
    panelElement.className = CONFIG.PANEL_HIDDEN_CLASS;
    
    updatePanelTheme();
    
    // Header
    const header = document.createElement('div');
    header.className = 'live-gmail-header';
    
    const title = document.createElement('span');
    title.className = 'live-gmail-title';
    
    // Gmail logo
    const gmailLogo = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    gmailLogo.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    gmailLogo.setAttribute('width', '16');
    gmailLogo.setAttribute('height', '16');
    gmailLogo.setAttribute('viewBox', '0 0 48 48');
    gmailLogo.style.cssText = 'display:inline-block;vertical-align:middle;margin-right:6px';
    
    const gmailPath1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    gmailPath1.setAttribute('fill', '#4caf50');
    gmailPath1.setAttribute('d', 'M45,16.2l-5,2.75l-5,4.75L35,40h7c1.657,0,3-1.343,3-3V16.2z');
    
    const gmailPath2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    gmailPath2.setAttribute('fill', '#1e88e5');
    gmailPath2.setAttribute('d', 'M3,16.2l3.614,1.71L13,23.7V40H6c-1.657,0-3-1.343-3-3V16.2z');
    
    const gmailPolygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    gmailPolygon.setAttribute('fill', '#e53935');
    gmailPolygon.setAttribute('points', '35,11.2 24,19.45 13,11.2 12,17 13,23.7 24,31.95 35,23.7 36,17');
    
    const gmailPath3 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    gmailPath3.setAttribute('fill', '#c62828');
    gmailPath3.setAttribute('d', 'M3,12.298V16.2l10,7.5V11.2L9.876,8.859C9.132,8.301,8.228,8,7.298,8h0C4.924,8,3,9.924,3,12.298z');
    
    const gmailPath4 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    gmailPath4.setAttribute('fill', '#fbc02d');
    gmailPath4.setAttribute('d', 'M45,12.298V16.2l-10,7.5V11.2l3.124-2.341C38.868,8.301,39.772,8,40.702,8h0 C43.076,8,45,9.924,45,12.298z');
    
    gmailLogo.appendChild(gmailPath1);
    gmailLogo.appendChild(gmailPath2);
    gmailLogo.appendChild(gmailPolygon);
    gmailLogo.appendChild(gmailPath3);
    gmailLogo.appendChild(gmailPath4);
    
    title.appendChild(gmailLogo);
    title.appendChild(document.createTextNode('Unread'));
    header.appendChild(title);
    
    // Content
    const content = document.createElement('div');
    content.className = 'live-gmail-content';
    
    const loading = document.createElement('div');
    loading.className = 'live-gmail-loading';
    loading.textContent = 'Loading unread emails...';
    
    const emails = document.createElement('div');
    emails.className = 'live-gmail-emails';
    
    const error = document.createElement('div');
    error.className = 'live-gmail-error';
    error.style.display = 'none';
    
    content.appendChild(loading);
    content.appendChild(emails);
    content.appendChild(error);
    
    panelElement.appendChild(header);
    panelElement.appendChild(content);
    document.documentElement.appendChild(panelElement);
    
    watchThemeChanges();
    
    panelElement.addEventListener('mouseenter', () => {
      if (hoveredTab) panelElement.classList.remove(CONFIG.PANEL_HIDDEN_CLASS);
    });

    panelElement.addEventListener('mouseleave', hidePanel);
  }

  /**
   * Update panel theme
   */
  function updatePanelTheme() {
    if (!panelElement) return;
    
    let isDark = false;
    
    try {
      if (typeof Services !== 'undefined' && Services.prefs) {
        const zenScheme = Services.prefs.getIntPref('zen.view.window.scheme', 2);
        if (zenScheme === 0) isDark = true;
        else if (zenScheme === 1) isDark = false;
        else isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
          }
        } catch (e) {
      isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    
    if (isDark) {
      panelElement.setAttribute('data-theme', 'dark');
        } else {
      panelElement.removeAttribute('data-theme');
    }
  }

  /**
   * Watch for theme changes
   */
  function watchThemeChanges() {
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', updatePanelTheme);
    }
    
    try {
      if (typeof Services !== 'undefined' && Services.prefs) {
        Services.prefs.addObserver('zen.view.window.scheme', updatePanelTheme, false);
      }
    } catch (e) {}
    
    const observer = new MutationObserver(updatePanelTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['zen-should-be-dark-mode', 'data-theme']
    });
  }

  /**
   * Monitor tabs for Gmail
   */
  function setupTabMonitoring() {
    updateGmailTabs();

    if (gBrowser && gBrowser.tabContainer) {
      gBrowser.tabContainer.addEventListener('TabAttrModified', handleTabChange);
      gBrowser.tabContainer.addEventListener('TabOpen', handleTabChange);
      gBrowser.tabContainer.addEventListener('TabClose', handleTabChange);
    }

    const observer = new MutationObserver(updateGmailTabs);

    const essentials = document.getElementById('zen-essentials');
    if (essentials) {
      observer.observe(essentials, { childList: true, attributes: true, attributeFilter: ['zen-essential', 'data-url'] });
    }

    const tabs = document.getElementById('tabbrowser-tabs');
    if (tabs) {
      observer.observe(tabs, { childList: true, attributes: true, subtree: true, attributeFilter: ['zen-essential', 'data-url'] });
    }
  }


  /**
   * Update Gmail tabs list
   */
  function updateGmailTabs() {
    gmailTabs.clear();
    
    if (!gBrowser || !gBrowser.tabs) return;

    const pattern = getGmailUrlPattern();

    const activeWorkspace = window.gZenWorkspaces?.getActiveWorkspaceFromCache?.();
    const activeContainerId = activeWorkspace?.containerTabId || 0;

    for (const tab of gBrowser.tabs) {
      if (!tab.hasAttribute('zen-essential')) continue;

      // Skip essentials from other containers if container-specific essentials is enabled
      try {
        if (window.gZenWorkspaces?.containerSpecificEssentials && activeContainerId) {
          const tabContainerId = parseInt(tab.getAttribute('usercontextid') || 0, 10);
          if (tabContainerId !== activeContainerId) {
            continue;
          }
        }
      } catch (e) {}

      // Check both data-url (works when tab is hidden) and current URI (when tab is visible)
      const dataUrl = tab.getAttribute('data-url') || '';
      let tabUrl = '';
      
      // If tab is loaded (visible or hidden), prefer current URI
      if (tab.linkedBrowser && tab.linkedBrowser.currentURI) {
        try {
          tabUrl = tab.linkedBrowser.currentURI.spec;
        } catch (e) {}
      }
      
      // Fall back to data-url if no current URI
      if (!tabUrl) {
        tabUrl = dataUrl;
      }

      // Add if URL matches Gmail pattern
      if (tabUrl && tabUrl.includes(pattern)) {
        gmailTabs.set(tab, tabUrl);
        
        if (!tab.hasAttribute('data-live-gmail-listener')) {
          tab.addEventListener('mouseenter', handleTabHover);
          tab.addEventListener('mouseleave', handleTabLeave);
          tab.setAttribute('data-live-gmail-listener', 'true');
        }
      }
    }

    // Request scan from open Gmail tabs
    requestScanFromGmailTabs();
  }

  /**
   * Get Gmail URL pattern
   */
  function getGmailUrlPattern() {
    try {
      if (typeof Services !== 'undefined' && Services.prefs) {
        return Services.prefs.getStringPref(CONFIG.GMAIL_URL_PREF, CONFIG.DEFAULT_GMAIL_URL);
      }
    } catch (e) {}
    return CONFIG.DEFAULT_GMAIL_URL;
  }

  /**
   * Handle tab hover
   */
  function handleTabHover(event) {
    const tab = event.currentTarget;
    if (!tab.hasAttribute('zen-essential')) return;
    
    // Check if this is a Gmail essential tab (by URL pattern in data-url or current URI)
    const pattern = getGmailUrlPattern();
    let isGmailTab = false;
    
    // Check data-url attribute (works even when tab is closed)
    const dataUrl = tab.getAttribute('data-url') || '';
    if (dataUrl.includes(pattern)) {
      isGmailTab = true;
    }
    
    // If tab is open, also check current URI
    if (!isGmailTab && tab.linkedBrowser && tab.linkedBrowser.currentURI) {
      try {
        const tabUrl = tab.linkedBrowser.currentURI.spec;
        if (tabUrl && tabUrl.includes(pattern)) {
          isGmailTab = true;
        }
      } catch (e) {}
    }
    
    if (!isGmailTab) {
      hidePanel();
      return;
    }
    
    hoveredTab = tab;
    showPanel(tab);
  }

  /**
   * Handle tab leave
   */
  function handleTabLeave() {
    setTimeout(() => {
      if (!panelElement || !panelElement.matches(':hover')) {
        hidePanel();
      }
    }, 100);
  }

  /**
   * Check if there is at least one Gmail tab open
   */
  function hasGmailTab() {
    try {
      const pattern = getGmailUrlPattern();
      
      // Check tabs via browsers
      if (gBrowser && gBrowser.browsers) {
        for (const browser of gBrowser.browsers) {
          try {
            const spec = browser.currentURI ? browser.currentURI.spec : '';
            if (spec && spec.includes(pattern)) {
              return true;
            }
          } catch (e) {
            continue;
          }
        }
      }
      
      return false;
    } catch (e) {
      console.warn('[Live Gmail] hasGmailTab check failed:', e);
      return false;
    }
  }

  /**
   * Show panel
   */
  function showPanel(tab) {
    const hasOpenGmailTab = hasGmailTab();
    const hasCachedData = cachedEmails.length > 0;
    
    // Show panel if we have an open Gmail tab OR cached data
    if (!hasOpenGmailTab && !hasCachedData) {
      debugLog('No Gmail tab and no cached data; not showing panel');
      hidePanel();
      return;
    }
    
    // If tab is provided, verify it's a Gmail essential tab
    if (tab && !tab.hasAttribute('zen-essential')) {
      hidePanel();
      return;
    }

    if (!panelElement) createPanel();

    const tabRect = tab ? tab.getBoundingClientRect() : { bottom: 100, right: 100, left: 100, top: 100 };
    let top = tabRect.bottom - 3;
    let left = tabRect.right - 3;

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const panelRect = panelElement.getBoundingClientRect();
    
    if (left + panelRect.width > viewportWidth) left = tabRect.left - panelRect.width - 2;
    if (top + panelRect.height > viewportHeight) top = tabRect.top - panelRect.height - 2;
    if (left < 0) left = 10;
    if (top < 0) top = 10;

    panelElement.style.top = `${top}px`;
    panelElement.style.left = `${left}px`;
    panelElement.classList.remove(CONFIG.PANEL_HIDDEN_CLASS);

    updateEmailDisplay();
    
    // Only request fresh scan if we have an open Gmail tab
    if (hasOpenGmailTab) {
      requestScanFromGmailTabs();
    }
  }

  /**
   * Hide panel
   */
  function hidePanel() {
    if (panelElement) panelElement.classList.add(CONFIG.PANEL_HIDDEN_CLASS);
    hoveredTab = null;
  }

  /**
   * Handle tab changes
   */
  function handleTabChange() {
    updateGmailTabs();
  }

  /**
   * Update panel content
   */
  function updatePanelContent() {
    if (!panelElement) return;
    
    const content = panelElement.querySelector('.live-gmail-content');
    if (!content) return;
    
    content.innerHTML = `
        <div class="live-gmail-loading">Loading unread emails...</div>
        <div class="live-gmail-emails"></div>
        <div class="live-gmail-error" style="display: none;"></div>
      `;
      updateEmailDisplay();
  }

  /**
   * Update email display
   */
  function updateEmailDisplay() {
    if (!panelElement) return;

    const emailsContainer = panelElement.querySelector('.live-gmail-emails');
    const loadingContainer = panelElement.querySelector('.live-gmail-loading');

    if (!emailsContainer) return;

    if (loadingContainer) loadingContainer.style.display = 'none';
    emailsContainer.innerHTML = '';

    // Use current emails, or fall back to cached emails if no Gmail tab is open
    const emailsToShow = currentEmails.length > 0 ? currentEmails : cachedEmails;

    if (emailsToShow.length === 0) {
      emailsContainer.innerHTML = '<div class="live-gmail-empty">No unread emails</div>';
      return;
    }

    emailsToShow.forEach(email => {
      const el = document.createElement('div');
      el.className = 'live-gmail-email-item';
      if (email.isUnread) el.classList.add('live-gmail-unread');
      
      // Ensure consistent height
      el.style.minHeight = '70px';
      el.style.height = '70px';
      el.style.display = 'flex';
      el.style.flexDirection = 'column';
      
      const from = email.from.replace(/<[^>]*>/g, '').trim();
      const subject = email.subject || '(No subject)';
      const snippet = email.snippet || '';
      const date = formatDate(email.date);

      el.innerHTML = `
        <div class="live-gmail-email-header" style="flex-shrink: 0;">
          <span class="live-gmail-email-from">${escapeHtml(from)}</span>
          <span class="live-gmail-email-date">${escapeHtml(date)}</span>
        </div>
        <div class="live-gmail-email-subject" style="flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(subject)}</div>
        <div class="live-gmail-email-snippet" style="flex: 1; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; min-height: 0; padding-top: 2px; line-height: 1.3;">${escapeHtml(snippet)}</div>
      `;

      el.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        let targetTab = hoveredTab;
        
        // If no hoveredTab (cached email), find or create Gmail essential tab
        if (!targetTab && gBrowser) {
          const pattern = getGmailUrlPattern();
          const gmailUrl = `https://${pattern}/`;

          const activeWorkspace = window.gZenWorkspaces?.getActiveWorkspaceFromCache?.();
          const activeContainerId = activeWorkspace?.containerTabId || 0;

          // Try to find existing Gmail essential tab in the active container (if applicable)
          for (const tab of gBrowser.tabs) {
            if (!tab.hasAttribute('zen-essential')) {
              continue;
            }

            if (window.gZenWorkspaces?.containerSpecificEssentials && activeContainerId) {
              const tabContainerId = parseInt(tab.getAttribute('usercontextid') || 0, 10);
              if (tabContainerId !== activeContainerId) {
                continue;
              }
            }

            const tabUrl = tab.linkedBrowser?.currentURI?.spec || tab.getAttribute('data-url') || '';
            if (tabUrl.includes(pattern)) {
              targetTab = tab;
              break;
            }
          }

          // If not found, create new tab (ideally in the active container)
          if (!targetTab) {
            try {
              let addTabArgs = {
                triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()
              };
              if (activeContainerId) {
                addTabArgs.userContextId = activeContainerId;
              }

              targetTab = gBrowser.addTab(gmailUrl, addTabArgs);
              if (targetTab && !targetTab.hasAttribute('zen-essential')) {
                if (window.gZenPinnedTabManager?.addToEssentials) {
                  window.gZenPinnedTabManager.addToEssentials(targetTab);
                } else {
                  targetTab.setAttribute('zen-essential', 'true');
                }
              }
            } catch (err) {
              console.warn('[Live Gmail] Could not create Gmail tab:', err);
              return;
            }
          }
        }
        
        if (!targetTab || !gBrowser) return;
        
        // Select the tab
        if (gBrowser.selectedTab !== targetTab) {
          gBrowser.selectedTab = targetTab;
        }
        
        let gmailUrl = email.url || `https://mail.google.com/mail/u/0/#inbox/${email.threadId || email.id}`;
        
        if (!/^https?:/i.test(gmailUrl)) {
          if (gmailUrl.startsWith('#')) {
            gmailUrl = 'https://mail.google.com/mail/u/0/' + gmailUrl;
          } else {
            gmailUrl = 'https://mail.google.com/mail/u/0/' + gmailUrl;
          }
        }
        
        debugLog('Opening email at rowIndex:', email.rowIndex, 'url:', gmailUrl);

        // Wait for tab to be ready, then send OpenThread message
        const waitForTabReady = (tab, maxAttempts = 50) => {
          return new Promise((resolve) => {
            let attempts = 0;
            let gmailReady = false;
            let readyCheckListener = null;
            
            const checkReady = () => {
              attempts++;
              
              if (tab.linkedBrowser && tab.linkedBrowser.messageManager) {
                try {
                  const browser = tab.linkedBrowser;
                  const uri = browser.currentURI;
                  
                  if (uri && uri.spec.includes(getGmailUrlPattern())) {
                    // Browser is loaded and on Gmail
                    if (!gmailReady) {
                      // First time: inject frame script and wait for Gmail to be ready
                      loadFrameScript(browser);
                      
                      // Set up listener for ready status
                      if (!readyCheckListener) {
                        readyCheckListener = (message) => {
                          if (message.name === 'LiveGmail:ReadyStatus' && message.data && message.data.ready) {
                            gmailReady = true;
                            debugLog('Gmail inbox is ready, rows:', message.data.rows);
                            
                            // Now send the OpenThread message immediately
                            try {
                              debugLog('Sending OpenThread message:', {
                                threadId: email.threadId || email.id,
                                url: gmailUrl,
                                rowIndex: email.rowIndex
                              });
                              browser.messageManager.sendAsyncMessage('LiveGmail:OpenThread', {
                                threadId: email.threadId || email.id,
                                url: gmailUrl,
                                rowIndex: email.rowIndex
                              });
                              debugLog('Sent OpenThread to tab');
                              
                              // Clean up listener
                              if (readyCheckListener) {
                                Services.mm.removeMessageListener('LiveGmail:ReadyStatus', readyCheckListener);
                              }
                              resolve(true);
                            } catch (err) {
                              console.warn('[Live Gmail] Could not send OpenThread:', err);
                              if (readyCheckListener) {
                                Services.mm.removeMessageListener('LiveGmail:ReadyStatus', readyCheckListener);
                              }
                              resolve(false);
                            }
                          }
                        };
                        
                        Services.mm.addMessageListener('LiveGmail:ReadyStatus', readyCheckListener);
                      }
                      
                      // Request ready check from frame script immediately
                      try {
                        browser.messageManager.sendAsyncMessage('LiveGmail:CheckReady', {});
                      } catch (e) {
                        debugLog('Could not send CheckReady:', e);
                      }
                    }
                    
                    // Continue checking if not ready yet
                    if (!gmailReady && attempts < maxAttempts) {
                      setTimeout(checkReady, 50);
                    } else if (!gmailReady) {
                      console.warn('[Live Gmail] Gmail did not become ready in time');
                      if (readyCheckListener) {
                        Services.mm.removeMessageListener('LiveGmail:ReadyStatus', readyCheckListener);
                      }
                      resolve(false);
                    }
                    return;
                  }
                } catch (e) {
                  debugLog('Error checking tab ready:', e);
                }
              }
              
              if (attempts >= maxAttempts) {
                console.warn('[Live Gmail] Tab did not become ready in time');
                if (readyCheckListener) {
                  Services.mm.removeMessageListener('LiveGmail:ReadyStatus', readyCheckListener);
                }
                resolve(false);
                return;
              }
              
              setTimeout(checkReady, 100);
            };
            
            // Also listen for load event
            if (tab.linkedBrowser) {
              tab.linkedBrowser.addEventListener('load', () => {
                setTimeout(checkReady, 500);
              }, { once: true });
            }
            
            checkReady();
          });
        };

        // Always use waitForTabReady to ensure frame script is loaded
        waitForTabReady(targetTab).then((success) => {
          if (success) {
            debugLog('Successfully navigated to email');
          } else {
            console.warn('[Live Gmail] Failed to navigate to email, falling back to URL navigation');
            // Fallback: navigate via URL
            try {
              const browser = targetTab.linkedBrowser;
              if (browser && browser.currentURI) {
                browser.loadURI(gmailUrl, {
                  triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()
                });
              }
            } catch (err) {
              console.warn('[Live Gmail] Could not navigate via URL:', err);
            }
          }
        });
        
        // Track clicked email by its stable ID
        clickedEmailIds.add(email.id);
        
        // Remove from current list
        const idx = currentEmails.findIndex(e => e.id === email.id);
        if (idx !== -1) {
          currentEmails.splice(idx, 1);
        }
        
        // Also remove from cache
        const cacheIdx = cachedEmails.findIndex(e => e.id === email.id);
        if (cacheIdx !== -1) {
          cachedEmails.splice(cacheIdx, 1);
        }
        
        updateEmailDisplay();
        
        // Immediately ask all Gmail tabs to rescan to avoid stale state
        requestScanFromGmailTabs();
        
        hidePanel();
      });

      emailsContainer.appendChild(el);
    });
  }

  /**
   * Show error
   */
  function showError(message) {
    if (!panelElement) return;
    const el = panelElement.querySelector('.live-gmail-error');
    const loading = panelElement.querySelector('.live-gmail-loading');
    if (el) { el.textContent = message; el.style.display = 'block'; }
    if (loading) loading.style.display = 'none';
  }

  /**
   * Hide error
   */
  function hideError() {
    if (!panelElement) return;
    const el = panelElement.querySelector('.live-gmail-error');
    if (el) el.style.display = 'none';
  }

  /**
   * Format date - always returns "Mon DD" format
   */
  function formatDate(dateString) {
    if (!dateString) return '';
    
    try {
      // First, strip any trailing time tokens like "11/01" or "12:30"
      let cleanDate = dateString.trim();
      const timeMatch = cleanDate.match(/^(.+?)\s+\d{1,2}[\/:]\d{1,2}/);
      if (timeMatch) {
        cleanDate = timeMatch[1].trim();
      }
      
      // Try parsing the cleaned date
      let parsed = Date.parse(cleanDate);
      
      
      // If we got a valid date, format it
      if (!Number.isNaN(parsed)) {
        const date = new Date(parsed);
        return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      }
      
      // Last resort: try to extract just month and day from the string
      const monthDayMatch = cleanDate.match(/(\w+)\s+(\d{1,2})/i);
      if (monthDayMatch) {
        return monthDayMatch[1] + ' ' + monthDayMatch[2];
      }
      
      return cleanDate;
    } catch (e) {
      return dateString;
    }
  }

  /**
   * Escape HTML
   */
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ============================================
  // Initialization
  // ============================================

  const UC_LIVE_GMAIL = {
    init: function() {
      if (!window.gBrowser || !window.gZenPinnedTabManager) {
        if (isDebugEnabled()) console.warn('LiveGmail: gBrowser or ZenPinnedTabManager not ready, retrying...');
        setTimeout(() => this.init(), 200);
        return;
      }

      debugLog('Initializing UC_LIVE_GMAIL...');

      patchZenPinnedTabManager();
      createPanel();
      setupTabMonitoring();
      initDomMode();
      updatePanelContent();
      
      debugLog('Initialized successfully');
    }
  };

  // Debug functions
  window.liveGmailDebug = {
    showPanel: () => {
      if (panelElement) {
        panelElement.classList.remove(CONFIG.PANEL_HIDDEN_CLASS);
        panelElement.style.top = '100px';
        panelElement.style.left = '100px';
      }
    },
    hidePanel,
    scan: requestScanFromGmailTabs,
    emails: () => currentEmails,
    reInit: () => UC_LIVE_GMAIL.init()
  };

  if (document.readyState === 'complete') {
    UC_LIVE_GMAIL.init();
  } else {
    window.addEventListener('DOMContentLoaded', () => UC_LIVE_GMAIL.init());
  }

})();
