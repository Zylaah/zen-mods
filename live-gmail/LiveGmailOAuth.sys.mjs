const { CONFIG, debugLog, getGmailUrlPattern } = ChromeUtils.importESModule(
  'chrome://sine/content/live-gmail/LiveGmailUtil.sys.mjs' + new URL(import.meta.url).search
);

const { NetUtil } = ChromeUtils.importESModule('resource://gre/modules/NetUtil.sys.mjs');
const Cr = Components.results;

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_ROOT = 'https://gmail.googleapis.com/gmail/v1/users/me';

function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeHeader(value) {
  const decoded = String(value || '').replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (_, charset, encoding, text) => {
      try {
        let bytes;
        if (String(encoding).toUpperCase() === 'B') {
          const binary = atob(text);
          bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
        } else {
          const qp = text
            .replace(/_/g, ' ')
            .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
          bytes = Uint8Array.from(qp, (ch) => ch.charCodeAt(0));
        }
        return new TextDecoder(charset || 'utf-8').decode(bytes);
      } catch (e) {
        return text;
      }
    }
  );
  return decoded.replace(/\s+/g, ' ').trim();
}

function senderFrom(from) {
  const decoded = decodeHeader(from);
  const match = decoded.match(/^(.*)<([^>]+)>\s*$/);
  if (!match) return decoded || 'Unknown';
  const name = match[1].trim().replace(/^"|"$/g, '');
  return name || match[2].trim();
}

function headerValue(message, name) {
  const headers = message?.payload?.headers || [];
  const wanted = name.toLowerCase();
  const header = headers.find((item) => String(item.name || '').toLowerCase() === wanted);
  return header?.value || '';
}

function googleError(text, status) {
  try {
    const data = JSON.parse(text || '{}');
    if (typeof data.error === 'string') return data.error_description || data.error;
    if (data.error?.message) return data.error.message;
  } catch (e) {}
  return 'HTTP ' + status;
}

export class LiveGmailOAuth {
  constructor(app) {
    this.app = app;
    this.tokens = null;
    this.authPromise = null;
    this.pollTimer = null;
    this.server = null;
  }

  tokenPath() {
    const profileDir = Services.dirsvc.get('ProfD', Ci.nsIFile).path;
    return PathUtils.join(profileDir, CONFIG.OAUTH_FILE);
  }

  clientSecret(explicit) {
    const given = String(explicit || '').trim();
    if (given) return given;
    try {
      return Services.prefs.getStringPref(CONFIG.OAUTH_CLIENT_SECRET_PREF, '').trim();
    } catch (e) {
      return '';
    }
  }

  clientId(explicit) {
    const given = String(explicit || '').trim();
    if (given) return given;
    try {
      return Services.prefs.getStringPref(CONFIG.OAUTH_CLIENT_ID_PREF, '').trim();
    } catch (e) {
      return '';
    }
  }

  load() {
    try {
      const file = Services.dirsvc.get('ProfD', Ci.nsIFile);
      file.append(CONFIG.OAUTH_FILE);
      if (!file.exists() || !file.fileSize) {
        this.tokens = null;
        return;
      }
      const stream = Cc['@mozilla.org/network/file-input-stream;1'].createInstance(Ci.nsIFileInputStream);
      stream.init(file, 0x01, 0, 0);
      const text = NetUtil.readInputStreamToString(stream, stream.available(), { charset: 'UTF-8' });
      stream.close();
      const parsed = JSON.parse(text);
      this.tokens = parsed?.refreshToken ? parsed : null;
    } catch (e) {
      this.tokens = null;
      debugLog('OAuth token load failed', e && e.message ? e.message : e);
    }
  }

  async save() {
    const path = this.tokenPath();
    if (!this.tokens?.refreshToken) {
      try { await IOUtils.remove(path); } catch (e) {}
      return;
    }
    const stored = {
      refreshToken: this.tokens.refreshToken,
      accessToken: this.tokens.accessToken || '',
      expiresAt: this.tokens.expiresAt || 0,
      email: this.tokens.email || '',
      scope: this.tokens.scope || GMAIL_SCOPE
    };
    await IOUtils.writeUTF8(path, JSON.stringify(stored));
  }

  isConnected() {
    return !!this.tokens?.refreshToken;
  }

  status() {
    return {
      connected: this.isConnected(),
      email: this.tokens?.email || '',
      expiresAt: this.tokens?.expiresAt || 0
    };
  }

  startPoll() {
    this.stopPoll();
    if (!this.isConnected()) return;
    const win = this.app.window;
    this.pollTimer = win.setInterval(() => {
      const tab = this.app.tabs.findAnchor();
      if (tab) this.app.atom.requestScan(tab, { force: true });
    }, CONFIG.OAUTH_POLL_MS);
  }

  stopPoll() {
    if (!this.pollTimer) return;
    try { this.app.window.clearInterval(this.pollTimer); } catch (e) {}
    this.pollTimer = null;
  }

  async disconnect() {
    this.stopPoll();
    this.#closeServer();
    this.tokens = null;
    await this.save();
    debugLog('OAuth disconnected');
  }

  async authorize(clientId, clientSecret) {
    if (this.authPromise) return this.authPromise;
    this.authPromise = this.#authorize(clientId, clientSecret).finally(() => {
      this.authPromise = null;
    });
    return this.authPromise;
  }

  async #authorize(clientId, clientSecret) {
    const id = this.clientId(clientId);
    if (!id) {
      throw new Error('Set ' + CONFIG.OAUTH_CLIENT_ID_PREF + ' to your Desktop OAuth client id');
    }
    if (clientId) {
      Services.prefs.setStringPref(CONFIG.OAUTH_CLIENT_ID_PREF, id);
    }
    const secret = this.clientSecret(clientSecret);
    if (clientSecret) {
      Services.prefs.setStringPref(CONFIG.OAUTH_CLIENT_SECRET_PREF, secret);
    }

    const win = this.app.window;
    const crypto = win.crypto;
    const verifierBytes = new Uint8Array(32);
    crypto.getRandomValues(verifierBytes);
    const verifier = base64url(verifierBytes);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = base64url(new Uint8Array(digest));
    const stateBytes = new Uint8Array(16);
    crypto.getRandomValues(stateBytes);
    const state = base64url(stateBytes);

    const redirectUri = await this.#listen(state);
    const params = new URLSearchParams({
      client_id: id,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: GMAIL_SCOPE,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
      state
    });
    const tab = win.gBrowser.addTab(AUTH_URL + '?' + params.toString(), {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()
    });
    win.gBrowser.selectedTab = tab;
    this.#watchAuthTab(tab);
    debugLog('OAuth consent opened', redirectUri);

    try {
      const code = await this.pendingCode;
      const token = await this.#tokenRequest({
        code,
        client_id: id,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        code_verifier: verifier
      });
      this.tokens = {
        refreshToken: token.refresh_token,
        accessToken: token.access_token,
        expiresAt: Date.now() + (Number(token.expires_in) || 3600) * 1000,
        email: '',
        scope: token.scope || GMAIL_SCOPE
      };
      try {
        const profile = await this.#apiGet(token.access_token, API_ROOT + '/profile');
        this.tokens.email = profile.emailAddress || '';
      } catch (e) {}
      await this.save();
      this.startPoll();
      debugLog('OAuth connected', this.tokens.email || 'account');
      const anchor = this.app.tabs.findAnchor();
      if (anchor) this.app.atom.requestScan(anchor, { force: true });
    } finally {
      this.#closeServer();
      try {
        if (tab && !tab.closing) win.gBrowser.removeTab(tab);
      } catch (e) {}
    }
  }

  async fetchUnread() {
    if (!this.isConnected()) throw new Error('OAuth is not connected');
    const granted = String(this.tokens?.scope || '');
    if (granted && !granted.includes('gmail.readonly')) {
      const err = new Error('Reconnect Gmail to load message snippets');
      err.reauth = true;
      throw err;
    }
    return this.#withToken(async (token) => {
      const query = new URLSearchParams({ maxResults: String(CONFIG.MAX_EMAILS) });
      query.append('labelIds', 'INBOX');
      query.append('labelIds', 'UNREAD');
      const list = await this.#apiGet(token, API_ROOT + '/messages?' + query.toString());
      const ids = Array.isArray(list.messages) ? list.messages : [];
      const messages = await Promise.all(ids.map((item) => {
        const detail = new URLSearchParams({
          format: 'full',
          fields: 'id,threadId,snippet,internalDate,payload/headers'
        });
        return this.#apiGet(token, API_ROOT + '/messages/' + encodeURIComponent(item.id) + '?' + detail.toString());
      }));
      const host = getGmailUrlPattern();
      const emails = messages.map((message, sourceRank) => {
        const subject = decodeHeader(headerValue(message, 'Subject')) || '(No subject)';
        const from = senderFrom(headerValue(message, 'From'));
        const dateHeader = headerValue(message, 'Date');
        const ts = Number(message.internalDate) || Date.parse(dateHeader);
        const threadId = message.threadId || message.id;
        const id = 'gmail:api:' + (message.id || threadId);
        return {
          id,
          threadId,
          from,
          subject,
          snippet: String(message.snippet || '').slice(0, 200),
          date: Number.isFinite(ts) ? new Date(ts).toISOString() : dateHeader,
          ts: Number.isFinite(ts) ? ts : 0,
          isUnread: true,
          url: `https://${host}/mail/u/0/#inbox/${threadId}`,
          rowIndex: sourceRank
        };
      });
      emails.sort((a, b) => (b.ts || 0) - (a.ts || 0) || a.rowIndex - b.rowIndex);
      return emails.slice(0, CONFIG.MAX_EMAILS);
    });
  }

  async #withToken(fn) {
    let token = await this.#accessToken(false);
    try {
      return await fn(token);
    } catch (e) {
      if (e?.status !== 401) throw e;
      token = await this.#accessToken(true);
      return fn(token);
    }
  }

  async #accessToken(force) {
    const current = this.tokens || {};
    if (!force && current.accessToken && current.expiresAt > Date.now() + 60000) {
      return current.accessToken;
    }
    const clientId = this.clientId();
    if (!clientId) throw new Error('Missing ' + CONFIG.OAUTH_CLIENT_ID_PREF);
    if (!current.refreshToken) throw new Error('OAuth is not connected');
    let token;
    try {
      token = await this.#tokenRequest({
        client_id: clientId,
        refresh_token: current.refreshToken,
        grant_type: 'refresh_token'
      });
    } catch (e) {
      if (e?.code === 'invalid_grant') {
        this.tokens = null;
        await this.save();
        this.stopPoll();
        const err = new Error('Gmail connection expired');
        err.reauth = true;
        throw err;
      }
      throw e;
    }
    this.tokens = {
      ...current,
      accessToken: token.access_token,
      expiresAt: Date.now() + (Number(token.expires_in) || 3600) * 1000,
      refreshToken: token.refresh_token || current.refreshToken,
      scope: token.scope || current.scope || GMAIL_SCOPE
    };
    await this.save();
    return this.tokens.accessToken;
  }

  #tokenRequest(fields) {
    const secret = this.clientSecret();
    const payload = secret ? { ...fields, client_secret: secret } : { ...fields };
    const body = new URLSearchParams(payload).toString();
    return this.#request({ method: 'POST', url: TOKEN_URL, body }).then((result) => {
      let data = {};
      try { data = JSON.parse(result.text || '{}'); } catch (e) {}
      if (result.status < 200 || result.status >= 300 || data.error) {
        let message = googleError(result.text, result.status);
        if (/client_secret is missing/i.test(message)) {
          message = 'Pass your OAuth client secret as the second argument to authorize()';
        }
        const err = new Error(message);
        err.status = result.status;
        err.code = typeof data.error === 'string' ? data.error : '';
        throw err;
      }
      return data;
    });
  }

  async #apiGet(token, url) {
    const result = await this.#request({
      method: 'GET',
      url,
      headers: { Authorization: 'Bearer ' + token }
    });
    let data = {};
    try { data = JSON.parse(result.text || '{}'); } catch (e) {}
    if (result.status < 200 || result.status >= 300) {
      const err = new Error(googleError(result.text, result.status));
      err.status = result.status;
      throw err;
    }
    return data;
  }

  #request({ method, url, headers, body }) {
    const channel = NetUtil.newChannel({
      uri: Services.io.newURI(url),
      loadUsingSystemPrincipal: true
    }).QueryInterface(Ci.nsIHttpChannel);
    channel.loadFlags |= Ci.nsIRequest.LOAD_BYPASS_CACHE | Ci.nsIRequest.INHIBIT_CACHING;
    for (const [name, value] of Object.entries(headers || {})) {
      channel.setRequestHeader(name, value, false);
    }
    if (body) {
      const stream = Cc['@mozilla.org/io/string-input-stream;1'].createInstance(Ci.nsIStringInputStream);
      stream.setByteStringData(body);
      channel.QueryInterface(Ci.nsIUploadChannel).setUploadStream(
        stream,
        'application/x-www-form-urlencoded',
        body.length
      );
    }
    channel.requestMethod = method || 'GET';
    return new Promise((resolve, reject) => {
      NetUtil.asyncFetch(channel, (input, requestStatus, request) => {
        if (!Components.isSuccessCode(requestStatus)) {
          reject(new Error('Network error'));
          return;
        }
        let text = '';
        try {
          const available = input.available();
          if (available > 0) text = NetUtil.readInputStreamToString(input, available, { charset: 'UTF-8' });
        } catch (e) {}
        let status = 0;
        try { status = request.QueryInterface(Ci.nsIHttpChannel).responseStatus; } catch (e) {}
        resolve({ status, text });
      });
    });
  }

  #listen(expectedState) {
    this.#closeServer();
    const server = Cc['@mozilla.org/network/server-socket;1'].createInstance(Ci.nsIServerSocket);
    server.init(-1, true, 4);
    this.server = server;
    const redirectUri = 'http://127.0.0.1:' + server.port;
    this.redirectUri = redirectUri;
    this.expectedState = expectedState;
    this._authDone = false;
    this._lastAuthLocation = '';
    this.pendingCode = new Promise((resolve, reject) => {
      this._resolveCode = resolve;
      this._rejectCode = reject;
      this._authTimer = this.app.window.setTimeout(() => {
        this.#failAuth(new Error('OAuth timed out'));
      }, 180000);
    });
    this._redirectObserver = {
      observe: (subject) => {
        try {
          this.#acceptRedirect(subject.QueryInterface(Ci.nsIHttpChannel).URI.spec);
        } catch (e) {}
      }
    };
    Services.obs.addObserver(this._redirectObserver, 'http-on-modify-request');
    server.asyncListen({
      onSocketAccepted: (_socket, transport) => {
        this.#readAuthRequest(transport, expectedState);
      },
      onStopListening: () => {}
    });
    return Promise.resolve(redirectUri);
  }

  #watchAuthTab(tab) {
    const browser = tab?.linkedBrowser;
    if (!browser) return;
    const listener = {
      QueryInterface: ChromeUtils.generateQI(['nsIWebProgressListener', 'nsISupportsWeakReference']),
      onLocationChange: (webProgress, _request, location) => {
        if (webProgress && !webProgress.isTopLevel) return;
        const spec = location?.spec || '';
        this.#noteAuthLocation(spec);
        this.#acceptRedirect(spec);
      },
      onStateChange() {},
      onProgressChange() {},
      onStatusChange() {},
      onSecurityChange() {},
      onContentBlockingEvent() {}
    };
    try {
      browser.addProgressListener(listener, Ci.nsIWebProgress.NOTIFY_LOCATION);
      this._authProgress = { browser, listener };
    } catch (e) {}
  }

  #noteAuthLocation(spec) {
    let url;
    try { url = new URL(spec); } catch (e) { return; }
    const where = url.origin + url.pathname;
    if (where === this._lastAuthLocation) return;
    this._lastAuthLocation = where;
    debugLog('OAuth tab', where);
    if (url.hostname !== 'accounts.google.com') return;
    const error = url.searchParams.get('error') || url.searchParams.get('authError') || '';
    if (/redirect_uri_mismatch|invalid_client|unauthorized_client|access_denied|invalid_scope/.test(error)) {
      debugLog('OAuth page error', error);
      this.#failAuth(new Error(error));
    }
  }

  #acceptRedirect(spec) {
    if (this._authDone) return;
    let url;
    try { url = new URL(spec); } catch (e) { return; }
    if (url.origin !== new URL(this.redirectUri).origin) return;
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    if (!state && !error && !code) return;
    if (state !== this.expectedState) {
      this.#failAuth(new Error(error || 'OAuth state mismatch'));
      return;
    }
    if (error) {
      debugLog('OAuth redirect error', error);
      this.#failAuth(new Error(error));
      return;
    }
    if (!code) return;
    this.#completeAuth(code);
  }

  #completeAuth(code) {
    if (this._authDone) return;
    this._authDone = true;
    debugLog('OAuth code received');
    try { this.app.window.clearTimeout(this._authTimer); } catch (e) {}
    this._resolveCode?.(code);
  }

  #failAuth(error) {
    if (this._authDone) return;
    this._authDone = true;
    try { this.app.window.clearTimeout(this._authTimer); } catch (e) {}
    this._rejectCode?.(error);
  }

  #readAuthRequest(transport, expectedState) {
    const input = transport.openInputStream(0, 0, 0).QueryInterface(Ci.nsIAsyncInputStream);
    const output = transport.openOutputStream(0, 0, 0);
    const chunks = [];
    const reader = {
      onInputStreamReady: (stream) => {
        try {
          let available = 0;
          try { available = stream.available(); } catch (e) {
            stream.asyncWait(reader, 0, 0, Services.tm.currentThread);
            return;
          }
          if (available > 0) {
            const binary = Cc['@mozilla.org/binaryinputstream;1'].createInstance(Ci.nsIBinaryInputStream);
            binary.setInputStream(stream);
            chunks.push(binary.readBytes(available));
          }
          const data = chunks.join('');
          if (!data.includes('\r\n\r\n') && data.length < 65536) {
            stream.asyncWait(reader, 0, 0, Services.tm.currentThread);
            return;
          }
          this.#finishAuthRequest(data, output, transport, expectedState);
        } catch (e) {
          try { transport.close(Cr.NS_OK); } catch (err) {}
        }
      }
    };
    input.asyncWait(reader, 0, 0, Services.tm.currentThread);
  }

  #finishAuthRequest(data, output, transport, expectedState) {
    const requestLine = data.split('\r\n', 1)[0] || '';
    const query = requestLine.match(/\?([^ ]*)/)?.[1] || '';
    try { this.#acceptRedirect(this.redirectUri + '/?' + query); } catch (e) {}
    const params = new URLSearchParams(query);
    const isCallback = params.has('code') || params.has('error') || params.has('state');
    const page = isCallback
      ? '<!DOCTYPE html><title>Live Gmail</title><p>Live Gmail is connected. You can close this tab.</p>'
      : '<!DOCTYPE html><title>Live Gmail</title><p>Not found.</p>';
    const status = isCallback ? '200 OK' : '404 Not Found';
    const header =
      'HTTP/1.1 ' + status + '\r\n' +
      'Content-Type: text/html; charset=utf-8\r\n' +
      'Content-Length: ' + new TextEncoder().encode(page).length + '\r\n' +
      'Connection: close\r\n\r\n';
    try {
      output.write(header, header.length);
      output.write(page, page.length);
    } catch (e) {}
    try { transport.close(Cr.NS_OK); } catch (e) {}
    if (params.get('state') === expectedState && params.get('code')) {
      this.#completeAuth(params.get('code'));
    }
  }

  #closeServer() {
    try { this.app.window.clearTimeout(this._authTimer); } catch (e) {}
    if (this._redirectObserver) {
      try { Services.obs.removeObserver(this._redirectObserver, 'http-on-modify-request'); } catch (e) {}
      this._redirectObserver = null;
    }
    if (this._authProgress) {
      try { this._authProgress.browser.removeProgressListener(this._authProgress.listener); } catch (e) {}
      this._authProgress = null;
    }
    try { this.server?.close(); } catch (e) {}
    this.server = null;
  }
}

