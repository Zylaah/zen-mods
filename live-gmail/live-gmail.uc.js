// ==UserScript==
// @name           Live Gmail Panel
// @description    Displays Gmail inbox emails in a floating panel when hovering over Gmail essential tabs
// @author         Bxth
// @version        1.0
// @namespace      https://github.com/zen-browser/desktop
// ==/UserScript==

(function() {
  'use strict';

  // Configuration
  const CONFIG = {
    API_KEY_PREF: 'live-gmail.api-key',
    REFRESH_TOKEN_PREF: 'live-gmail.refresh-token',
    TOKEN_EXPIRY_PREF: 'live-gmail.token-expiry',
    POLL_INTERVAL_PREF: 'live-gmail.poll-interval',
    GMAIL_URL_PREF: 'live-gmail.url',
    DEFAULT_POLL_INTERVAL: 5 * 60 * 1000, // 5 minutes in milliseconds
    DEFAULT_GMAIL_URL: 'mail.google.com',
    MAX_EMAILS: 20, // Increased to ensure we get recent emails
    PANEL_ID: 'live-gmail-panel',
    PANEL_HIDDEN_CLASS: 'live-gmail-hidden',
    
    // OAuth Configuration (PKCE + client_secret for Desktop apps)
    OAUTH: {
      CLIENT_ID: 'YOUR_CLIENT_ID',
      CLIENT_SECRET: 'YOUR_CLIENT_SECRET',
      SCOPES: 'https://www.googleapis.com/auth/gmail.readonly',
      AUTH_URL: 'https://accounts.google.com/o/oauth2/v2/auth',
      TOKEN_URL: 'https://oauth2.googleapis.com/token',
      // IMPORTANT: You must add http://localhost to your OAuth client's authorized redirect URIs
      // in Google Cloud Console. This is a ONE-TIME setup for the developer.
      // End users don't need to configure anything - they just copy the code from the URL.
      REDIRECT_URI: 'http://localhost'
    }
  };

  // State
  let pollInterval = null;
  let currentEmails = [];
  let hoveredTab = null;
  let panelElement = null;
  let gmailTabs = new Map(); // Map of tab elements to their URLs
  let oauthPopup = null; // OAuth popup window reference
  let isAuthenticating = false; // Flag to prevent multiple auth attempts
  let currentCodeVerifier = null; // PKCE code verifier for current OAuth flow
  let clickedEmailIds = new Set(); // Track clicked emails to hide them until confirmed as read

  // Initialize when browser is ready
  if (gBrowserInit && gBrowserInit.delayedStartupFinished) {
    init();
  } else {
    window.addEventListener('DOMContentLoaded', init);
    if (document.readyState === 'complete') {
      init();
    }
  }

  function init() {
    // Wait for gBrowser to be available
    if (typeof gBrowser === 'undefined') {
      setTimeout(init, 100);
      return;
    }

    console.log('[Live Gmail] Initializing...');
    
    injectStyles();
    createPanel();
    setupTabMonitoring();
    
    // Update disconnect button visibility on init
    updateDisconnectButtonVisibility();
    
    // Only start polling if we have a token
    if (hasValidToken() || getApiKey()) {
      startPolling();
    } else {
      // Update panel to show connect button
      updatePanelForAuthState();
    }
    
    console.log('[Live Gmail] Initialized successfully');
  }

  /**
   * Inject CSS styles into the document
   */
  function injectStyles() {
    // Check if styles already injected
    if (document.getElementById('live-gmail-styles')) {
      return;
    }

    try {
      const styleSheet = document.createElement('link');
      styleSheet.id = 'live-gmail-styles';
      styleSheet.rel = 'stylesheet';
      styleSheet.type = 'text/css';
      
      // Try to load from chrome directory
      if (typeof Services !== 'undefined') {
        const profileDir = Services.dirsvc.get('ProfD', Ci.nsIFile);
        const chromeDir = profileDir.clone();
        chromeDir.append('chrome');
        const cssFile = chromeDir.clone();
        cssFile.append('live-gmail.css');
        
        if (cssFile.exists()) {
          const cssPath = Services.io.newFileURI(cssFile).spec;
          styleSheet.href = cssPath;
          document.head.appendChild(styleSheet);
          console.log('[Live Gmail] CSS loaded from:', cssPath);
          return;
        } else {
          console.warn('[Live Gmail] CSS file not found at:', cssFile.path, '- CSS may be loaded via userChrome.css instead');
        }
      } else {
        console.warn('[Live Gmail] Services not available - CSS should be loaded via userChrome.css');
      }
    } catch (e) {
      console.warn('[Live Gmail] Could not load external CSS:', e, '- CSS should be loaded via userChrome.css');
    }
  }

  /**
   * Create the floating panel element
   */
  function createPanel() {
    if (panelElement) {
      return;
    }

    panelElement = document.createElement('div');
    panelElement.id = CONFIG.PANEL_ID;
    panelElement.className = CONFIG.PANEL_HIDDEN_CLASS;
    
    // Detect dark mode and add data attribute
    updatePanelTheme();
    
    // Build panel structure using DOM methods (innerHTML with buttons gets blocked by CSP)
    
    // Header
    const header = document.createElement('div');
    header.className = 'live-gmail-header';
    
    const title = document.createElement('span');
    title.className = 'live-gmail-title';
    
    // Create Gmail logo SVG
    const gmailLogo = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    gmailLogo.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    gmailLogo.setAttribute('width', '16');
    gmailLogo.setAttribute('height', '16');
    gmailLogo.setAttribute('viewBox', '0 0 48 48');
    gmailLogo.style.display = 'inline-block';
    gmailLogo.style.verticalAlign = 'middle';
    gmailLogo.style.marginRight = '6px';
    
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
    
    // Create text node for "Unread"
    const unreadText = document.createTextNode('Unread');
    
    title.appendChild(gmailLogo);
    title.appendChild(unreadText);
    
    const disconnectBtn = document.createElement('button');
    disconnectBtn.id = 'live-gmail-disconnect-btn';
    disconnectBtn.className = 'live-gmail-disconnect-btn';
    disconnectBtn.title = 'Disconnect Gmail';
    disconnectBtn.style.display = 'none'; // Hidden by default
    
    // Add logout icon as inline SVG (so it respects currentColor)
    const logoutIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    logoutIcon.setAttribute('width', '16');
    logoutIcon.setAttribute('height', '16');
    logoutIcon.setAttribute('viewBox', '0 0 24 24');
    logoutIcon.style.display = 'block';
    
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('fill', 'none');
    g.setAttribute('stroke', 'currentColor');
    g.setAttribute('stroke-linecap', 'round');
    g.setAttribute('stroke-width', '1.5');
    
    const path1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path1.setAttribute('d', 'M9.002 7c.012-2.175.109-3.353.877-4.121C10.758 2 12.172 2 15 2h1c2.829 0 4.243 0 5.122.879C22 3.757 22 5.172 22 8v8c0 2.828 0 4.243-.878 5.121C20.242 22 18.829 22 16 22h-1c-2.828 0-4.242 0-5.121-.879c-.768-.768-.865-1.946-.877-4.121');
    
    const path2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path2.setAttribute('stroke-linejoin', 'round');
    path2.setAttribute('d', 'M15 12H2m0 0l3.5-3M2 12l3.5 3');
    
    g.appendChild(path1);
    g.appendChild(path2);
    logoutIcon.appendChild(g);
    disconnectBtn.appendChild(logoutIcon);
    disconnectBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm('Disconnect Gmail account?')) {
        disconnectGmail();
      }
    });
    
    header.appendChild(title);
    header.appendChild(disconnectBtn);
    
    // Content area
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

    // Add to document
    document.documentElement.appendChild(panelElement);
    
    // Watch for theme changes
    watchThemeChanges();
    
    // Update panel based on auth state
    updatePanelForAuthState();

    // Add event listeners to keep panel visible when hovering over it
    panelElement.addEventListener('mouseenter', () => {
      if (hoveredTab) {
        panelElement.classList.remove(CONFIG.PANEL_HIDDEN_CLASS);
      }
    });

    panelElement.addEventListener('mouseleave', () => {
      hidePanel();
    });
  }

  /**
   * Update panel theme based on Zen browser theme settings
   * Follows Zen's theme detection approach:
   * 1. Check Zen's explicit theme preference (zen.view.window.scheme)
   * 2. Check zen-should-be-dark-mode attribute
   * 3. Check computed color-scheme CSS property
   * 4. Fall back to prefers-color-scheme media query
   */
  function updatePanelTheme() {
    if (!panelElement) return;
    
    let isDark = null; // null = not determined yet
    
    // Method 1: Check Zen's theme preference (zen.view.window.scheme)
    // 0 = dark, 1 = light, 2 = system/auto
    try {
      if (typeof Services !== 'undefined' && Services.prefs) {
        const zenScheme = Services.prefs.getIntPref('zen.view.window.scheme', 2);
        if (zenScheme === 0) {
          // Explicitly dark
          isDark = true;
        } else if (zenScheme === 1) {
          // Explicitly light
          isDark = false;
        } else if (zenScheme === 2) {
          // System/auto - check system preference
          if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
            isDark = true;
          } else {
            isDark = false;
          }
        }
      }
    } catch (e) {
      // Services not available, continue to other methods
    }
    
    // Method 2: Check zen-should-be-dark-mode attribute on root or browser element
    if (isDark === null) {
      try {
        const root = document.documentElement;
        const browser = document.getElementById('browser');
        
        if (root && root.hasAttribute('zen-should-be-dark-mode')) {
          isDark = root.getAttribute('zen-should-be-dark-mode') === 'true';
        } else if (browser && browser.hasAttribute('zen-should-be-dark-mode')) {
          isDark = browser.getAttribute('zen-should-be-dark-mode') === 'true';
        }
      } catch (e) {
        // Continue to next method
      }
    }
    
    // Method 3: Check computed color-scheme CSS property
    if (isDark === null) {
      try {
        const colorScheme = getComputedStyle(document.documentElement).colorScheme;
        if (colorScheme === 'dark') {
          isDark = true;
        } else if (colorScheme === 'light') {
          isDark = false;
        }
      } catch (e) {
        // Continue to fallback
      }
    }
    
    // Method 4: Fallback to prefers-color-scheme media query
    if (isDark === null) {
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
        isDark = true;
      } else {
        isDark = false;
      }
    }
    
    // Apply theme to panel
    if (isDark) {
      panelElement.setAttribute('data-theme', 'dark');
    } else {
      panelElement.removeAttribute('data-theme');
    }
    
    console.log('[Live Gmail] Theme detected:', isDark ? 'dark' : 'light');
  }

  /**
   * Watch for theme changes
   * Monitors:
   * - System prefers-color-scheme changes
   * - Zen preference changes (zen.view.window.scheme)
   * - zen-should-be-dark-mode attribute changes
   * - color-scheme CSS property changes
   */
  function watchThemeChanges() {
    // Watch system prefers-color-scheme changes
    if (window.matchMedia) {
      const darkModeQuery = window.matchMedia('(prefers-color-scheme: dark)');
      darkModeQuery.addEventListener('change', updatePanelTheme);
    }
    
    // Watch for Zen preference changes
    try {
      if (typeof Services !== 'undefined' && Services.prefs) {
        Services.prefs.addObserver('zen.view.window.scheme', () => {
          updatePanelTheme();
        }, false);
      }
    } catch (e) {
      // Services not available
    }
    
    // Watch for attribute changes on document root and browser element
    const observer = new MutationObserver(() => {
      updatePanelTheme();
    });
    
    // Observe document root for theme-related attributes
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['zen-should-be-dark-mode', 'lwtheme', 'style', 'data-theme']
    });
    
    // Also observe browser element if it exists
    const browser = document.getElementById('browser');
    if (browser) {
      observer.observe(browser, {
        attributes: true,
        attributeFilter: ['zen-should-be-dark-mode', 'style']
      });
    }
  }

  /**
   * Monitor tabs for Gmail essential tabs
   */
  function setupTabMonitoring() {
    // Monitor existing tabs
    updateGmailTabs();

    // Monitor tab changes
    if (gBrowser && gBrowser.tabContainer) {
      gBrowser.tabContainer.addEventListener('TabAttrModified', handleTabChange);
      gBrowser.tabContainer.addEventListener('TabOpen', handleTabChange);
      gBrowser.tabContainer.addEventListener('TabClose', handleTabChange);
    }

    // Also monitor DOM mutations for essential tabs
    const observer = new MutationObserver(() => {
      updateGmailTabs();
    });

    const essentialsContainer = document.getElementById('zen-essentials');
    if (essentialsContainer) {
      observer.observe(essentialsContainer, {
        childList: true,
        attributes: true,
        attributeFilter: ['zen-essential', 'data-url']
      });
    }

    // Observe tabbrowser-tabs container as well
    const tabsContainer = document.getElementById('tabbrowser-tabs');
    if (tabsContainer) {
      observer.observe(tabsContainer, {
        childList: true,
        attributes: true,
        subtree: true,
        attributeFilter: ['zen-essential', 'data-url']
      });
    }
  }

  /**
   * Update the list of Gmail essential tabs
   */
  function updateGmailTabs() {
    gmailTabs.clear();
    
    if (!gBrowser || !gBrowser.tabs) {
      console.warn('[Live Gmail] gBrowser or gBrowser.tabs not available');
      return;
    }

    const gmailUrlPattern = getGmailUrlPattern();
    console.log('[Live Gmail] Looking for Gmail tabs with pattern:', gmailUrlPattern);
    console.log('[Live Gmail] Total tabs:', gBrowser.tabs.length);
    
    let essentialTabsFound = 0;
    let gmailTabsFound = 0;
    
    // Check all tabs
    for (const tab of gBrowser.tabs) {
      if (!tab.hasAttribute('zen-essential')) {
        continue;
      }
      
      essentialTabsFound++;

      let tabUrl = '';
      try {
        // Try to get URL from linkedBrowser
        if (tab.linkedBrowser && tab.linkedBrowser.currentURI) {
          tabUrl = tab.linkedBrowser.currentURI.spec;
        }
        // Fallback to data-url attribute
        if (!tabUrl && tab.hasAttribute('data-url')) {
          tabUrl = tab.getAttribute('data-url');
        }
      } catch (e) {
        console.warn('[Live Gmail] Error getting tab URL:', e);
      }

      // Check if this is a Gmail tab
      if (tabUrl && tabUrl.includes(gmailUrlPattern)) {
        const tabElement = tab;
        gmailTabs.set(tabElement, tabUrl);
        gmailTabsFound++;
        console.log('[Live Gmail] Found Gmail tab:', tabUrl);
        
        // Attach hover listeners if not already attached
        if (!tabElement.hasAttribute('data-live-gmail-listener')) {
          console.log('[Live Gmail] Attaching hover listeners to Gmail tab');
          attachHoverListeners(tabElement);
          tabElement.setAttribute('data-live-gmail-listener', 'true');
        }
      }
    }
    
    console.log('[Live Gmail] Tab scan complete - Essential tabs:', essentialTabsFound, 'Gmail tabs:', gmailTabsFound);
  }

  /**
   * Get Gmail URL pattern from preferences
   */
  function getGmailUrlPattern() {
    try {
      if (typeof Services !== 'undefined' && Services.prefs) {
        const customUrl = Services.prefs.getStringPref(CONFIG.GMAIL_URL_PREF, CONFIG.DEFAULT_GMAIL_URL);
        return customUrl;
      }
    } catch (e) {
      // Fallback to localStorage or default
    }
    return CONFIG.DEFAULT_GMAIL_URL;
  }

  /**
   * Attach hover event listeners to a Gmail tab
   */
  function attachHoverListeners(tabElement) {
    tabElement.addEventListener('mouseenter', handleTabHover);
    tabElement.addEventListener('mouseleave', handleTabLeave);
  }

  /**
   * Handle tab hover
   */
  function handleTabHover(event) {
    const tab = event.currentTarget;
    console.log('[Live Gmail] Tab hovered:', tab, 'is essential:', tab.hasAttribute('zen-essential'));
    
    if (!tab.hasAttribute('zen-essential')) {
      return;
    }

    hoveredTab = tab;
    console.log('[Live Gmail] Showing panel for Gmail tab');
    showPanel(tab);
  }

  /**
   * Handle tab leave
   */
  function handleTabLeave(event) {
    // Small delay to allow moving to panel
    setTimeout(() => {
      if (!panelElement || !panelElement.matches(':hover')) {
        hidePanel();
      }
    }, 100);
  }

  /**
   * Show the panel positioned relative to the tab
   */
  function showPanel(tab) {
    if (!panelElement) {
      console.log('[Live Gmail] Panel element not found, creating...');
      createPanel();
    }
    
    if (!panelElement) {
      console.error('[Live Gmail] Failed to create panel element!');
      return;
    }

    // Position panel: top-left corner of panel at bottom-right corner of tab
    const tabRect = tab.getBoundingClientRect();
    const panelRect = panelElement.getBoundingClientRect();
    console.log('[Live Gmail] Positioning panel - tab rect:', tabRect, 'panel rect:', panelRect);
    
    // Start with panel's top-left at tab's bottom-right (with small gap)
    let top = tabRect.bottom - 3;
    let left = tabRect.right - 3;

    // Adjust if panel would go off screen
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    
    // If panel would go off the right edge, position it to the left of the tab
    if (left + panelRect.width > viewportWidth) {
      left = tabRect.left - panelRect.width - 5;
    }
    
    // If panel would go off the bottom, position it above the tab
    if (top + panelRect.height > viewportHeight) {
      top = tabRect.top - panelRect.height - 5;
    }

    // Ensure panel stays within viewport bounds
    if (left < 0) {
      left = 10;
    }
    if (top < 0) {
      top = 10;
    }
    if (left + panelRect.width > viewportWidth) {
      left = viewportWidth - panelRect.width - 10;
    }
    if (top + panelRect.height > viewportHeight) {
      top = viewportHeight - panelRect.height - 10;
    }

    panelElement.style.top = `${top}px`;
    panelElement.style.left = `${left}px`;
    panelElement.classList.remove(CONFIG.PANEL_HIDDEN_CLASS);

    // Update email display
    updateEmailDisplay();
  }

  /**
   * Hide the panel
   */
  function hidePanel() {
    if (panelElement) {
      panelElement.classList.add(CONFIG.PANEL_HIDDEN_CLASS);
    }
    hoveredTab = null;
  }

  /**
   * Handle tab changes
   */
  function handleTabChange() {
    updateGmailTabs();
  }

  /**
   * Start polling for emails
   */
  function startPolling() {
    // Clear existing interval
    if (pollInterval) {
      clearInterval(pollInterval);
    }

    // Initial fetch
    fetchEmails();

    // Set up polling
    const interval = getPollInterval();
    pollInterval = setInterval(() => {
      fetchEmails();
    }, interval);
  }

  /**
   * Get poll interval from preferences
   */
  function getPollInterval() {
    try {
      if (typeof Services !== 'undefined' && Services.prefs) {
        const interval = Services.prefs.getIntPref(CONFIG.POLL_INTERVAL_PREF, CONFIG.DEFAULT_POLL_INTERVAL);
        return interval;
      }
    } catch (e) {
      // Fallback to default
    }
    return CONFIG.DEFAULT_POLL_INTERVAL;
  }

  /**
   * Fetch emails from Gmail API
   */
  async function fetchEmails() {
    // Get token with automatic refresh if expired
    const apiKey = await getApiKeyWithRefresh();
    
    if (!apiKey) {
      // No token - show connect button
      console.log('[Live Gmail] No valid token, showing connect button');
      updatePanelForAuthState();
      return;
    }

    // Show disconnect button when authenticated
    updateDisconnectButtonVisibility();

    try {
      const userId = 'me';
      // Fetch all unread messages from inbox
      const url = `https://gmail.googleapis.com/gmail/v1/users/${userId}/messages?maxResults=${CONFIG.MAX_EMAILS}&q=in:inbox is:unread -label:sent -label:draft -label:spam -label:trash`;
      
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        if (response.status === 401) {
          // Token might be invalid, try to refresh
          console.log('[Live Gmail] Got 401, attempting token refresh...');
          const refreshed = await refreshAccessToken();
          if (refreshed) {
            // Retry fetch with new token
            console.log('[Live Gmail] Token refreshed, retrying email fetch...');
            return fetchEmails();
          } else {
            // Refresh failed, need to re-authenticate
            console.log('[Live Gmail] Token refresh failed, prompting for re-authentication');
            showError('Authentication expired. Please reconnect your Gmail account.');
            updatePanelForAuthState();
            return;
          }
        } else {
          const errorText = await response.text();
          console.error('[Live Gmail] API error:', response.status, errorText);
          showError(`API error: ${response.status} ${response.statusText}`);
        }
        return;
      }

      const data = await response.json();
      
      if (!data.messages || data.messages.length === 0) {
        currentEmails = [];
        updateEmailDisplay();
        return;
      }

      // Fetch full message details
      const messagePromises = data.messages.slice(0, CONFIG.MAX_EMAILS).map(msg => 
        fetchMessageDetails(msg.id, apiKey)
      );

      const messages = await Promise.all(messagePromises);
      // Filter to only include unread messages from inbox (double-check labels)
      // Also exclude emails that have been clicked (they'll be removed from clickedEmailIds once confirmed as read)
      const fetchedEmailIds = new Set();
      currentEmails = messages.filter(msg => {
        if (!msg) return false;
        fetchedEmailIds.add(msg.id);
        // Verify the message is still unread and in inbox
        const hasUnread = msg.labelIds && msg.labelIds.includes('UNREAD');
        const inInbox = msg.labelIds && msg.labelIds.includes('INBOX');
        // Exclude messages from other folders (sent, draft, spam, trash)
        const notInOtherFolders = !msg.labelIds || (
          !msg.labelIds.includes('SENT') &&
          !msg.labelIds.includes('DRAFT') &&
          !msg.labelIds.includes('SPAM') &&
          !msg.labelIds.includes('TRASH')
        );
        // Exclude clicked emails (they're being opened, so hide them until confirmed as read)
        const notClicked = !clickedEmailIds.has(msg.id);
        return hasUnread && inInbox && notInOtherFolders && notClicked;
      });
      
      // Clean up clickedEmailIds: remove emails that are no longer in the unread list (they've been read)
      clickedEmailIds.forEach(emailId => {
        if (!fetchedEmailIds.has(emailId)) {
          // Email is no longer in unread list, so it's been read - remove from clicked set
          clickedEmailIds.delete(emailId);
        }
      });
      
      // Sort emails by date (most recent first)
      currentEmails.sort((a, b) => {
        // Use internalDate if available (more reliable), otherwise fall back to Date header
        const dateA = a.internalDate || (a.date ? new Date(a.date).getTime() : 0);
        const dateB = b.internalDate || (b.date ? new Date(b.date).getTime() : 0);
        return dateB - dateA; // Descending order (newest first)
      });
      
      updateEmailDisplay();
      hideError();

    } catch (error) {
      console.error('[Live Gmail] Error fetching emails:', error);
      showError(`Error: ${error.message}`);
    }
  }

  /**
   * Fetch detailed message information
   */
  async function fetchMessageDetails(messageId, apiKey) {
    try {
      const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`;
      
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        return null;
      }

      const data = await response.json();
      
      // Extract headers
      const headers = {};
      if (data.payload && data.payload.headers) {
        data.payload.headers.forEach(header => {
          headers[header.name.toLowerCase()] = header.value;
        });
      }

      // Get snippet
      const snippet = data.snippet || '';
      
      // Get label IDs to check if message is unread
      const labelIds = data.labelIds || [];
      
      // Use internalDate for sorting (more reliable than Date header)
      const internalDate = data.internalDate ? parseInt(data.internalDate) : null;

      return {
        id: messageId,
        threadId: data.threadId || messageId, // Store thread ID if available
        from: headers.from || 'Unknown',
        subject: headers.subject || '(No subject)',
        date: headers.date || '',
        internalDate: internalDate, // For sorting
        snippet: snippet,
        labelIds: labelIds, // Store labels to verify unread status
        isUnread: labelIds.includes('UNREAD')
      };
    } catch (error) {
      console.error('[Live Gmail] Error fetching message details:', error);
      return null;
    }
  }

  // ============================================
  // OAuth Functions with PKCE
  // ============================================

  /**
   * Generate a random string for PKCE
   */
  function generateRandomString(length) {
    const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    let result = '';
    const randomValues = new Uint8Array(length);
    crypto.getRandomValues(randomValues);
    for (let i = 0; i < length; i++) {
      result += charset[randomValues[i] % charset.length];
    }
    return result;
  }

  /**
   * Generate PKCE code verifier and challenge
   */
  async function generatePKCE() {
    // Generate code verifier (43-128 characters)
    const codeVerifier = generateRandomString(128);
    
    // Generate code challenge (SHA256 hash, base64url encoded)
    const encoder = new TextEncoder();
    const data = encoder.encode(codeVerifier);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashBase64 = btoa(String.fromCharCode(...hashArray))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
    
    return {
      codeVerifier: codeVerifier,
      codeChallenge: hashBase64
    };
  }

  /**
   * Check if we have a valid token
   */
  function hasValidToken() {
    const token = getApiKey();
    if (!token) return false;
    
    // Check if token is expired
    if (isTokenExpired()) {
      return false;
    }
    
    return true;
  }

  /**
   * Check if the current token is expired
   */
  function isTokenExpired() {
    try {
      if (typeof Services !== 'undefined' && Services.prefs) {
        // Try to get as string first (new format), fallback to int (old format)
        let expiry = 0;
        try {
          const expiryStr = Services.prefs.getStringPref(CONFIG.TOKEN_EXPIRY_PREF, '');
          if (expiryStr) {
            expiry = parseInt(expiryStr, 10);
          }
        } catch (e) {
          // Fallback to int pref for backwards compatibility
          expiry = Services.prefs.getIntPref(CONFIG.TOKEN_EXPIRY_PREF, 0);
        }
        
        if (expiry === 0 || isNaN(expiry)) {
          console.log('[Live Gmail] No expiry set, assuming token is valid');
          return false; // No expiry set, assume valid
        }
        const now = Date.now();
        const isExpired = now > expiry;
        if (isExpired) {
          console.log('[Live Gmail] Token expired. Now:', new Date(now).toLocaleString(), 'Expiry:', new Date(expiry).toLocaleString());
        } else {
          console.log('[Live Gmail] Token valid. Now:', new Date(now).toLocaleString(), 'Expiry:', new Date(expiry).toLocaleString());
        }
        return isExpired;
      }
    } catch (e) {
      console.warn('[Live Gmail] Error checking token expiry:', e);
      // If we can't check, assume not expired
    }
    return false;
  }

  /**
   * Start the OAuth flow with PKCE
   */
  async function startOAuthFlow() {
    if (isAuthenticating) {
      console.log('[Live Gmail] OAuth already in progress');
      return;
    }
    
    isAuthenticating = true;
    console.log('[Live Gmail] Starting OAuth flow with PKCE...');
    
    try {
      // Generate PKCE code verifier and challenge
      const pkce = await generatePKCE();
      currentCodeVerifier = pkce.codeVerifier;
      
      // Build the authorization URL with PKCE
      const authUrl = new URL(CONFIG.OAUTH.AUTH_URL);
      authUrl.searchParams.set('client_id', CONFIG.OAUTH.CLIENT_ID);
      authUrl.searchParams.set('redirect_uri', CONFIG.OAUTH.REDIRECT_URI);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', CONFIG.OAUTH.SCOPES);
      authUrl.searchParams.set('access_type', 'offline'); // Get refresh token
      authUrl.searchParams.set('prompt', 'consent'); // Always show consent to get refresh token
      authUrl.searchParams.set('code_challenge', pkce.codeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256'); // SHA256
      
      // Convert URL to string and log for debugging
      const authUrlString = authUrl.toString();
      console.log('[Live Gmail] OAuth URL:', authUrlString);
      
      // Open OAuth URL in a new tab (window.open is restricted in chrome context)
      try {
        // Use gBrowser to open in a new tab
        const newTab = gBrowser.addTab(authUrlString, {
          triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
          inBackground: false // Open in foreground
        });
        
        // Select the new tab
        gBrowser.selectedTab = newTab;
        
        // Store reference for monitoring
        oauthPopup = {
          tab: newTab,
          get closed() {
            return !newTab || !newTab.linkedBrowser;
          },
          close() {
            if (newTab && gBrowser) {
              gBrowser.removeTab(newTab);
            }
          }
        };
        
        console.log('[Live Gmail] OAuth tab opened successfully');
      } catch (openError) {
        console.error('[Live Gmail] Error opening OAuth tab:', openError);
        showError('Could not open authentication tab. Error: ' + openError.message);
        isAuthenticating = false;
        currentCodeVerifier = null;
        return;
      }
      
      // Show instructions in the panel
      showOAuthInstructions();
      
      // Monitor the popup for the authorization code
      monitorOAuthPopup();
    } catch (error) {
      console.error('[Live Gmail] Error starting OAuth flow:', error);
      showError(`Error starting authentication: ${error.message}`);
      isAuthenticating = false;
      currentCodeVerifier = null;
    }
  }

  /**
   * Show waiting message during OAuth flow (PKCE handles everything automatically)
   */
  function showOAuthInstructions() {
    if (!panelElement) return;
    
    const contentArea = panelElement.querySelector('.live-gmail-content');
    if (contentArea) {
      // Clear content area
      contentArea.innerHTML = '';
      
      // Simple waiting message - PKCE handles everything automatically
      const waitingDiv = document.createElement('div');
      waitingDiv.className = 'live-gmail-connect';
      
      const waitingText = document.createElement('p');
      waitingText.className = 'live-gmail-connect-text';
      waitingText.textContent = 'Waiting for connection...';
      waitingText.style.textAlign = 'center';
      
      const instructionsText = document.createElement('p');
      instructionsText.className = 'live-gmail-connect-text';
      instructionsText.textContent = 'Please authorize in the popup window';
      instructionsText.style.fontSize = '11px';
      instructionsText.style.color = '#737373';
      instructionsText.style.marginTop = '8px';
      instructionsText.style.textAlign = 'center';
      
      // Cancel button
      const cancelBtn = document.createElement('button');
      cancelBtn.id = 'live-gmail-cancel-auth';
      cancelBtn.className = 'live-gmail-cancel-button';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.style.marginTop = '16px';
      cancelBtn.addEventListener('click', () => {
        cancelOAuth();
      });
      
      waitingDiv.appendChild(waitingText);
      waitingDiv.appendChild(instructionsText);
      waitingDiv.appendChild(cancelBtn);
      contentArea.appendChild(waitingDiv);
    }
  }

  /**
   * Monitor the OAuth tab for completion
   */
  function monitorOAuthPopup() {
    if (!oauthPopup || !oauthPopup.tab) return;
    
    const tab = oauthPopup.tab;
    let lastUrl = '';
    
    // Function to check and process the URL
    const checkUrl = (url) => {
      if (!url || url === lastUrl) return false;
      lastUrl = url;
      
      // Check if redirected to localhost with code or error
      if (url.includes('localhost') || url.includes('127.0.0.1')) {
        console.log('[Live Gmail] Detected localhost redirect:', url);
        
        try {
          const urlObj = new URL(url);
          const code = urlObj.searchParams.get('code');
          const error = urlObj.searchParams.get('error');
          
          if (code) {
            console.log('[Live Gmail] Authorization code detected automatically!');
            return { code, error: null };
          } else if (error) {
            console.error('[Live Gmail] OAuth error:', error);
            return { code: null, error };
          }
        } catch (e) {
          console.warn('[Live Gmail] Could not parse URL:', e);
        }
      }
      return null;
    };
    
    // Try to add a progress listener for navigation events
    let progressListener = null;
    try {
      const browser = tab.linkedBrowser;
      if (browser && browser.webProgress) {
        progressListener = {
          onLocationChange: function(webProgress, request, location, flags) {
            if (location) {
              const url = location.spec;
              const result = checkUrl(url);
              if (result) {
                if (result.code) {
                  // Close the OAuth tab
                  if (oauthPopup && oauthPopup.close) {
                    oauthPopup.close();
                  }
                  // Exchange code for token
                  exchangeCodeForToken(result.code);
                } else if (result.error) {
                  // Close the OAuth tab
                  if (oauthPopup && oauthPopup.close) {
                    oauthPopup.close();
                  }
                  showError(`Authentication error: ${result.error}`);
                  isAuthenticating = false;
                  currentCodeVerifier = null;
                }
              }
            }
          }
        };
        browser.webProgress.addProgressListener(progressListener, 
          Components.interfaces.nsIWebProgress.NOTIFY_LOCATION);
        console.log('[Live Gmail] Added progress listener for OAuth tab');
      }
    } catch (e) {
      console.warn('[Live Gmail] Could not add progress listener:', e);
    }
    
    // Fallback: Poll the tab URL
    const checkTab = setInterval(() => {
      try {
        // Check if tab is closed/removed
        if (!tab || !tab.linkedBrowser || oauthPopup.closed) {
          clearInterval(checkTab);
          if (progressListener && tab.linkedBrowser && tab.linkedBrowser.webProgress) {
            try {
              tab.linkedBrowser.webProgress.removeProgressListener(progressListener);
            } catch (e) {}
          }
          console.log('[Live Gmail] OAuth tab closed');
          return;
        }
        
        // Try to detect redirect to localhost (OAuth callback)
        try {
          const browser = tab.linkedBrowser;
          if (browser && browser.currentURI) {
            const url = browser.currentURI.spec;
            const result = checkUrl(url);
            if (result) {
              clearInterval(checkTab);
              if (progressListener && browser.webProgress) {
                try {
                  browser.webProgress.removeProgressListener(progressListener);
                } catch (e) {}
              }
              
              if (result.code) {
                // Close the OAuth tab
                if (oauthPopup && oauthPopup.close) {
                  oauthPopup.close();
                }
                // Exchange code for token
                exchangeCodeForToken(result.code);
              } else if (result.error) {
                // Close the OAuth tab
                if (oauthPopup && oauthPopup.close) {
                  oauthPopup.close();
                }
                showError(`Authentication error: ${result.error}`);
                isAuthenticating = false;
                currentCodeVerifier = null;
              }
            }
          }
        } catch (e) {
          // Error accessing tab URL - might be cross-origin or page not loaded
          // This is normal when the page fails to load
        }
      } catch (e) {
        console.error('[Live Gmail] Error monitoring OAuth tab:', e);
      }
    }, 500);
  }

  /**
   * Exchange authorization code for tokens using PKCE
   */
  async function exchangeCodeForToken(code) {
    console.log('[Live Gmail] Exchanging code for token with PKCE...');
    
    if (!currentCodeVerifier) {
      throw new Error('Code verifier not found. Please restart the OAuth flow.');
    }
    
    try {
      const response = await fetch(CONFIG.OAUTH.TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          code: code,
          client_id: CONFIG.OAUTH.CLIENT_ID,
          client_secret: CONFIG.OAUTH.CLIENT_SECRET,
          redirect_uri: CONFIG.OAUTH.REDIRECT_URI,
          grant_type: 'authorization_code',
          code_verifier: currentCodeVerifier // PKCE: security for public clients
        })
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        console.error('[Live Gmail] Token exchange error details:', errorData);
        throw new Error(errorData.error_description || errorData.error || 'Token exchange failed');
      }
      
      const tokenData = await response.json();
      
      console.log('[Live Gmail] Token response:', {
        hasAccessToken: !!tokenData.access_token,
        hasRefreshToken: !!tokenData.refresh_token,
        expiresIn: tokenData.expires_in,
        tokenType: tokenData.token_type
      });
      
      // Save the tokens
      saveTokens(tokenData);
      
      // Verify refresh token was saved
      if (!tokenData.refresh_token) {
        console.warn('[Live Gmail] No refresh token in response. This can happen if:');
        console.warn('  1. You\'ve already authorized this app before');
        console.warn('  2. Google only provides refresh tokens on first authorization');
        console.warn('  Solution: Revoke access at https://myaccount.google.com/permissions and re-authenticate');
        showError('Warning: No refresh token received. Token will expire in 1 hour. Revoke access and reconnect to get a refresh token.');
      } else {
        console.log('[Live Gmail] Refresh token received and saved');
      }
      
      // Clear code verifier (no longer needed)
      currentCodeVerifier = null;
      
      // Close popup if still open
      if (oauthPopup && !oauthPopup.closed) {
        oauthPopup.close();
      }
      
      isAuthenticating = false;
      
      console.log('[Live Gmail] OAuth successful with PKCE!');
      
      // Start polling for emails
      startPolling();
      
      // Refresh the panel to show emails
      updatePanelForAuthState();
      
      // Fetch emails immediately
      fetchEmails();
      
    } catch (error) {
      console.error('[Live Gmail] Token exchange error:', error);
      showError(`Authentication failed: ${error.message}`);
      isAuthenticating = false;
      currentCodeVerifier = null;
    }
  }

  /**
   * Save tokens to preferences
   */
  function saveTokens(tokenData) {
    try {
      if (typeof Services !== 'undefined' && Services.prefs) {
        // Save access token
        if (tokenData.access_token) {
          Services.prefs.setStringPref(CONFIG.API_KEY_PREF, tokenData.access_token);
          console.log('[Live Gmail] Access token saved');
        }
        
        // Save refresh token if provided
        if (tokenData.refresh_token) {
          Services.prefs.setStringPref(CONFIG.REFRESH_TOKEN_PREF, tokenData.refresh_token);
          console.log('[Live Gmail] Refresh token saved');
        } else {
          console.warn('[Live Gmail] No refresh token in tokenData');
        }
        
        // Save token expiry time (as string to avoid integer overflow issues)
        if (tokenData.expires_in) {
          const expiryTime = Date.now() + (tokenData.expires_in * 1000) - 60000; // Subtract 1 min buffer
          // Store as string to avoid potential integer overflow with large timestamps
          Services.prefs.setStringPref(CONFIG.TOKEN_EXPIRY_PREF, expiryTime.toString());
          console.log('[Live Gmail] Token expiry saved:', new Date(expiryTime).toLocaleString(), 'Timestamp:', expiryTime);
        }
        
        console.log('[Live Gmail] Tokens saved successfully');
      } else {
        console.error('[Live Gmail] Services.prefs not available');
      }
    } catch (e) {
      console.error('[Live Gmail] Error saving tokens:', e);
    }
  }

  /**
   * Refresh the access token using refresh token
   * Note: Refresh token flow doesn't require PKCE or client secret
   */
  async function refreshAccessToken() {
    console.log('[Live Gmail] Refreshing access token...');
    
    try {
      let refreshToken = '';
      if (typeof Services !== 'undefined' && Services.prefs) {
        refreshToken = Services.prefs.getStringPref(CONFIG.REFRESH_TOKEN_PREF, '');
        console.log('[Live Gmail] Refresh token retrieved:', refreshToken ? 'Found' : 'Not found');
      } else {
        console.error('[Live Gmail] Services.prefs not available');
        return false;
      }
      
      if (!refreshToken) {
        console.log('[Live Gmail] No refresh token available - user needs to re-authenticate');
        return false;
      }
      
      // Refresh token flow: for public/desktop clients, only client_id is needed
      const response = await fetch(CONFIG.OAUTH.TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          client_id: CONFIG.OAUTH.CLIENT_ID,
          client_secret: CONFIG.OAUTH.CLIENT_SECRET,
          refresh_token: refreshToken,
          grant_type: 'refresh_token'
        })
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        console.error('[Live Gmail] Token refresh failed:', {
          status: response.status,
          error: errorData
        });
        
        // If refresh token is invalid, clear it
        if (response.status === 400 && (errorData.error === 'invalid_grant' || errorData.error === 'invalid_request')) {
          console.log('[Live Gmail] Refresh token invalid, clearing stored tokens');
          if (typeof Services !== 'undefined' && Services.prefs) {
            Services.prefs.clearUserPref(CONFIG.REFRESH_TOKEN_PREF);
            Services.prefs.clearUserPref(CONFIG.API_KEY_PREF);
          }
        }
        
        return false;
      }
      
      const tokenData = await response.json();
      console.log('[Live Gmail] Token refresh response:', {
        hasAccessToken: !!tokenData.access_token,
        expiresIn: tokenData.expires_in
      });
      
      // Save the new access token (refresh token stays the same)
      saveTokens(tokenData);
      
      console.log('[Live Gmail] Token refreshed successfully');
      
      // Update panel to reflect new token
      updatePanelForAuthState();
      
      return true;
      
    } catch (error) {
      console.error('[Live Gmail] Error refreshing token:', error);
      return false;
    }
  }

  /**
   * Cancel OAuth flow
   */
  function cancelOAuth() {
    isAuthenticating = false;
    currentCodeVerifier = null; // Clear PKCE verifier
    
    if (oauthPopup && !oauthPopup.closed) {
      oauthPopup.close();
    }
    
    updatePanelForAuthState();
  }

  /**
   * Disconnect Gmail (clear tokens)
   */
  function disconnectGmail() {
    try {
      if (typeof Services !== 'undefined' && Services.prefs) {
        Services.prefs.clearUserPref(CONFIG.API_KEY_PREF);
        Services.prefs.clearUserPref(CONFIG.REFRESH_TOKEN_PREF);
        Services.prefs.clearUserPref(CONFIG.TOKEN_EXPIRY_PREF);
      }
      
      currentEmails = [];
      
      console.log('[Live Gmail] Disconnected from Gmail');
      
      // Update disconnect button
      updateDisconnectButtonVisibility();
      
      // Update panel
      updatePanelForAuthState();
      
    } catch (e) {
      console.error('[Live Gmail] Error disconnecting:', e);
    }
  }

  /**
   * Update disconnect button visibility
   */
  function updateDisconnectButtonVisibility() {
    if (!panelElement) {
      console.log('[Live Gmail] updateDisconnectButtonVisibility: No panel element');
      return;
    }
    
    const disconnectBtn = panelElement.querySelector('#live-gmail-disconnect-btn');
    if (disconnectBtn) {
      const hasToken = !!getApiKey();
      console.log('[Live Gmail] updateDisconnectButtonVisibility: hasToken =', hasToken);
      // Use empty string to let CSS handle the display, or 'none' to hide
      disconnectBtn.style.display = hasToken ? '' : 'none';
    } else {
      console.log('[Live Gmail] updateDisconnectButtonVisibility: Disconnect button not found');
    }
  }

  /**
   * Update panel based on authentication state
   */
  function updatePanelForAuthState() {
    console.log('[Live Gmail] updatePanelForAuthState called');
    
    if (!panelElement) {
      console.log('[Live Gmail] updatePanelForAuthState: No panel element');
      return;
    }
    
    // Update disconnect button visibility
    updateDisconnectButtonVisibility();
    
    let contentArea = panelElement.querySelector('.live-gmail-content');
    if (!contentArea) {
      console.log('[Live Gmail] updatePanelForAuthState: No content area, recreating...');
      // Recreate content area if missing
      contentArea = document.createElement('div');
      contentArea.className = 'live-gmail-content';
      panelElement.appendChild(contentArea);
    }
    
    const token = getApiKey();
    const tokenValid = hasValidToken();
    console.log('[Live Gmail] updatePanelForAuthState: token exists =', !!token, ', hasValidToken =', tokenValid, ', isAuthenticating =', isAuthenticating);
    
    // Show connect button if no token OR token is invalid
    if ((!token || !tokenValid) && !isAuthenticating) {
      console.log('[Live Gmail] Showing connect button');
      
      // Clear content area
      contentArea.innerHTML = '';
      
      // Create elements using DOM methods (innerHTML with buttons gets blocked by CSP)
      const connectDiv = document.createElement('div');
      connectDiv.className = 'live-gmail-connect';
      
      const connectText = document.createElement('p');
      connectText.className = 'live-gmail-connect-text';
      connectText.textContent = 'Connect your Gmail account to see unread emails';
      
      const connectBtn = document.createElement('button');
      connectBtn.id = 'live-gmail-connect-btn';
      connectBtn.className = 'live-gmail-connect-button';
      connectBtn.textContent = 'Connect Gmail';
      connectBtn.addEventListener('click', () => {
        console.log('[Live Gmail] Connect button clicked');
        startOAuthFlow();
      });
      
      connectDiv.appendChild(connectText);
      connectDiv.appendChild(connectBtn);
      contentArea.appendChild(connectDiv);
      
      console.log('[Live Gmail] Connect button created via DOM');
    } else if (!isAuthenticating) {
      console.log('[Live Gmail] Showing email display');
      // Show loading or emails
      contentArea.innerHTML = `
        <div class="live-gmail-loading">Loading unread emails...</div>
        <div class="live-gmail-emails"></div>
        <div class="live-gmail-error" style="display: none;"></div>
      `;
      
      // Update email display
      updateEmailDisplay();
    } else {
      console.log('[Live Gmail] Currently authenticating, not changing panel');
    }
  }

  /**
   * Get API key with automatic refresh if expired
   */
  async function getApiKeyWithRefresh() {
    let token = getApiKey();
    
    if (!token) {
      console.log('[Live Gmail] No access token found');
      return '';
    }
    
    // Check if token is expired
    if (isTokenExpired()) {
      console.log('[Live Gmail] Token expired, attempting refresh...');
      const refreshed = await refreshAccessToken();
      if (refreshed) {
        token = getApiKey();
        console.log('[Live Gmail] Got new token after refresh');
      } else {
        // Refresh failed, need to re-authenticate
        console.log('[Live Gmail] Token refresh failed, need to re-authenticate');
        return '';
      }
    } else {
      console.log('[Live Gmail] Token is still valid');
    }
    
    return token;
  }

  /**
   * Debug function to check token status (can be called from console)
   */
  window.checkLiveGmailTokens = function() {
    try {
      if (typeof Services === 'undefined' || !Services.prefs) {
        console.log('[Live Gmail] Services not available');
        return;
      }
      
      const accessToken = Services.prefs.getStringPref(CONFIG.API_KEY_PREF, '');
      const refreshToken = Services.prefs.getStringPref(CONFIG.REFRESH_TOKEN_PREF, '');
      const expiry = Services.prefs.getIntPref(CONFIG.TOKEN_EXPIRY_PREF, 0);
      
      console.log('[Live Gmail] Token Status:');
      console.log('  Access Token:', accessToken ? `***${accessToken.slice(-4)}` : 'NOT SET');
      console.log('  Refresh Token:', refreshToken ? `***${refreshToken.slice(-4)}` : 'NOT SET');
      console.log('  Expiry:', expiry ? new Date(expiry).toLocaleString() : 'NOT SET');
      console.log('  Is Expired:', expiry ? (Date.now() > expiry) : 'Unknown');
      
      return {
        hasAccessToken: !!accessToken,
        hasRefreshToken: !!refreshToken,
        expiry: expiry,
        isExpired: expiry ? (Date.now() > expiry) : null
      };
    } catch (e) {
      console.error('[Live Gmail] Error checking tokens:', e);
    }
  };

  /**
   * Debug function to manually show/hide disconnect button
   */
  window.showLiveGmailDisconnectBtn = function(show = true) {
    const btn = document.querySelector('#live-gmail-disconnect-btn');
    if (btn) {
      btn.style.display = show ? '' : 'none';
      console.log('[Live Gmail] Disconnect button display set to:', show ? 'visible' : 'hidden');
    } else {
      console.log('[Live Gmail] Disconnect button not found in DOM');
    }
  };

  /**
   * Debug function to disconnect Gmail (can be called from console)
   */
  window.disconnectLiveGmail = function() {
    disconnectGmail();
    console.log('[Live Gmail] Disconnected');
  };

  /**
   * Debug function to force show connect UI (can be called from console)
   */
  window.showLiveGmailConnectUI = function() {
    updatePanelForAuthState();
    console.log('[Live Gmail] Panel state updated');
  };

  /**
   * Debug function to manually trigger connect flow (can be called from console)
   */
  window.connectLiveGmail = function() {
    startOAuthFlow();
  };

  /**
   * Debug function to show/hide the panel (can be called from console)
   */
  window.showLiveGmailPanel = function(show = true) {
    if (!panelElement) {
      console.log('[Live Gmail] Panel element not created');
      return;
    }
    if (show) {
      panelElement.classList.remove(CONFIG.PANEL_HIDDEN_CLASS);
      panelElement.style.top = '100px';
      panelElement.style.left = '100px';
      console.log('[Live Gmail] Panel shown');
    } else {
      panelElement.classList.add(CONFIG.PANEL_HIDDEN_CLASS);
      console.log('[Live Gmail] Panel hidden');
    }
  };

  /**
   * Update the email display in the panel
   */
  function updateEmailDisplay() {
    if (!panelElement) {
      return;
    }

    const emailsContainer = panelElement.querySelector('.live-gmail-emails');
    const loadingContainer = panelElement.querySelector('.live-gmail-loading');
    const errorElement = panelElement.querySelector('.live-gmail-error');

    if (!emailsContainer) {
      return;
    }

    // Hide loading
    if (loadingContainer) {
      loadingContainer.style.display = 'none';
    }

    // Clear existing emails
    emailsContainer.innerHTML = '';

    if (currentEmails.length === 0) {
      emailsContainer.innerHTML = '<div class="live-gmail-empty">No unread emails</div>';
      return;
    }

    // Display emails
    currentEmails.forEach(email => {
      const emailElement = document.createElement('div');
      emailElement.className = 'live-gmail-email-item';
      
      // Add unread indicator class
      if (email.isUnread) {
        emailElement.classList.add('live-gmail-unread');
      }
      
      const from = email.from.replace(/<[^>]*>/g, '').trim(); // Remove email address, keep name
      const subject = email.subject || '(No subject)';
      const snippet = email.snippet || '';
      const date = formatDate(email.date);

      emailElement.innerHTML = `
        <div class="live-gmail-email-header">
          <span class="live-gmail-email-from">${escapeHtml(from)}</span>
          <span class="live-gmail-email-date">${escapeHtml(date)}</span>
        </div>
        <div class="live-gmail-email-subject">${escapeHtml(subject)}</div>
        <div class="live-gmail-email-snippet">${escapeHtml(snippet)}</div>
      `;

      // Add click handler to open email
      emailElement.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        
        if (hoveredTab && gBrowser) {
          // Switch to the Gmail tab first
          if (gBrowser.selectedTab !== hoveredTab) {
            gBrowser.selectedTab = hoveredTab;
          }
          
          // Try to get thread ID from the message for better Gmail URL
          let gmailUrl = `https://mail.google.com/mail/u/0/#inbox/${email.id}`;
          
          // If we have thread ID in the email data, use it
          if (email.threadId) {
            gmailUrl = `https://mail.google.com/mail/u/0/#inbox/${email.threadId}`;
          } else {
            // Try to fetch thread ID from message details
            try {
              const apiKey = getApiKey();
              if (apiKey) {
                const threadResponse = await fetch(
                  `https://gmail.googleapis.com/gmail/v1/users/me/messages/${email.id}?format=metadata&metadataHeaders=Thread-Id`,
                  {
                    headers: {
                      'Authorization': `Bearer ${apiKey}`,
                      'Content-Type': 'application/json'
                    }
                  }
                );
                if (threadResponse.ok) {
                  const threadData = await threadResponse.json();
                  if (threadData.threadId) {
                    gmailUrl = `https://mail.google.com/mail/u/0/#inbox/${threadData.threadId}`;
                  }
                }
              }
            } catch (err) {
              // Fallback to message ID if thread fetch fails
              console.warn('[Live Gmail] Could not fetch thread ID:', err);
            }
          }
          
          // Load the URL in the essential tab using proper triggering principal
          try {
            // Get the system principal for security (Services should be available in chrome context)
            if (typeof Services === 'undefined' || !Services.scriptSecurityManager) {
              throw new Error('Services not available');
            }
            
            const triggeringPrincipal = Services.scriptSecurityManager.getSystemPrincipal();
            
            // Convert URL string to nsIURI object
            const uri = Services.io.newURI(gmailUrl);
            
            // Use the tab's linkedBrowser.loadURI with URI object and triggering principal
            if (hoveredTab.linkedBrowser && hoveredTab.linkedBrowser.loadURI) {
              hoveredTab.linkedBrowser.loadURI(uri, {
                triggeringPrincipal: triggeringPrincipal
              });
            } else if (gBrowser && gBrowser.loadURI) {
              // Fallback: use gBrowser.loadURI
              gBrowser.loadURI(uri, {
                triggeringPrincipal: triggeringPrincipal
              }, hoveredTab);
            } else {
              throw new Error('No loadURI method available');
            }
          } catch (err) {
            // Last resort: try to navigate using the browser's contentWindow
            console.warn('[Live Gmail] Error loading URI with principal, trying fallback:', err);
            try {
              if (hoveredTab.linkedBrowser && hoveredTab.linkedBrowser.contentWindow) {
                hoveredTab.linkedBrowser.contentWindow.location.href = gmailUrl;
              } else {
                console.error('[Live Gmail] Could not load URL - no fallback available');
              }
            } catch (err2) {
              console.error('[Live Gmail] Could not load URL:', err2);
            }
          }
          
          // Track this email as clicked - it will be hidden until confirmed as read
          clickedEmailIds.add(email.id);
          
          // Remove the email from the current list (optimistic update)
          const emailIndex = currentEmails.findIndex(e => e.id === email.id);
          if (emailIndex !== -1) {
            currentEmails.splice(emailIndex, 1);
            updateEmailDisplay();
          }
          
          // Also refresh the email list after a short delay to catch any changes
          // The clicked email will be filtered out until it's confirmed as read
          setTimeout(() => {
            fetchEmails();
          }, 2000); // Refresh after 2 seconds
          
          // Hide the panel after clicking
          hidePanel();
        }
      });

      emailsContainer.appendChild(emailElement);
    });
  }

  /**
   * Show error message
   */
  function showError(message) {
    if (!panelElement) {
      return;
    }

    const errorElement = panelElement.querySelector('.live-gmail-error');
    const loadingContainer = panelElement.querySelector('.live-gmail-loading');
    
    if (errorElement) {
      errorElement.textContent = message;
      errorElement.style.display = 'block';
    }
    
    if (loadingContainer) {
      loadingContainer.style.display = 'none';
    }
  }

  /**
   * Hide error message
   */
  function hideError() {
    if (!panelElement) {
      return;
    }

    const errorElement = panelElement.querySelector('.live-gmail-error');
    if (errorElement) {
      errorElement.style.display = 'none';
    }
  }

  /**
   * Get API key from preferences
   */
  function getApiKey() {
    try {
      if (typeof Services !== 'undefined' && Services.prefs) {
        return Services.prefs.getStringPref(CONFIG.API_KEY_PREF, '');
      }
    } catch (e) {
      // Fallback: try localStorage
      try {
        return localStorage.getItem('live-gmail-api-key') || '';
      } catch (e2) {
        // localStorage not available in chrome context
      }
    }
    return '';
  }

  /**
   * Format date string
   */
  function formatDate(dateString) {
    if (!dateString) {
      return '';
    }

    try {
      const date = new Date(dateString);
      const now = new Date();
      const diff = now - date;
      const days = Math.floor(diff / (1000 * 60 * 60 * 24));

      if (days === 0) {
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      } else if (days === 1) {
        return 'Yesterday';
      } else if (days < 7) {
        return `${days} days ago`;
      } else {
        return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
      }
    } catch (e) {
      return dateString;
    }
  }

  /**
   * Escape HTML to prevent XSS
   */
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

})();

