const { NetUtil } = ChromeUtils.importESModule('resource://gre/modules/NetUtil.sys.mjs');
const { isExpired, markConnected, markExpired, setAccountEmail, setAccountMessage } = ChromeUtils.importESModule(
  'chrome://sine/content/zen-integrations/Accounts.sys.mjs' + new URL(import.meta.url).search
);
const {
  CONFIG,
  debugLog,
  findCallUrl,
  getTabUserContextId,
  localDay
} = ChromeUtils.importESModule(
  'chrome://sine/content/zen-integrations/calendar/LiveCalendarUtil.sys.mjs' + new URL(import.meta.url).search
);

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const ARC_GOOGLE_CLIENT = '223180603706-75q775r2840gbov4mos692ocm4q24onp.apps.googleusercontent.com';
const CLIENT_ID_RE = /^\d+-[a-z0-9_-]+\.apps\.googleusercontent\.com$/i;
const TOKEN_SKEW_MS = 60000;
const AUTH_TIMEOUT_MS = 180000;
const MAX_CALENDARS = 8;

let tokenStore = null;
let tokenWrite = Promise.resolve();
const authInFlight = new Set();

export function readGoogleClientId() {
  try {
    return Services.prefs.getStringPref(CONFIG.GOOGLE_CLIENT_PREF, '').trim();
  } catch (e) {
    return '';
  }
}

export function readGoogleClientSecret() {
  try {
    return Services.prefs.getStringPref(CONFIG.GOOGLE_CLIENT_SECRET_PREF, '').trim();
  } catch (e) {
    return '';
  }
}

function tokenFields(fields) {
  const secret = readGoogleClientSecret();
  if (!secret) return fields;
  return { ...fields, client_secret: secret };
}

function tokenError(payload) {
  const detail = payload?.error_description || payload?.error || 'Google token request failed';
  if (/client secret is missing/i.test(detail)) {
    return 'Add your Google client secret in live-calendar.google.clientSecret';
  }
  return detail;
}

export function googleClientState(clientId = readGoogleClientId()) {
  if (!clientId) return 'missing';
  if (clientId.toLowerCase() === ARC_GOOGLE_CLIENT) return 'foreign';
  if (!CLIENT_ID_RE.test(clientId)) return 'invalid';
  return 'ok';
}

export function googleSignInMessage(state = googleClientState()) {
  if (state === 'foreign') return 'Use your own Google app id. This one belongs to Arc.';
  if (state === 'invalid') return 'live-calendar.google.clientId is not a Google app id';
  if (state === 'missing') return 'Add your Google app id in live-calendar.google.clientId';
  return 'Sign in to Google Calendar';
}

function signInError(message, canSignIn) {
  const error = new Error(message || 'Sign-in required');
  error.signin = true;
  error.canSignIn = !!canSignIn;
  return error;
}

function base64Url(bytes) {
  const list = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  let binary = '';
  for (const value of list) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function cryptoApi(win) {
  return win?.crypto || globalThis.crypto || null;
}

function randomToken(win) {
  const bytes = new Uint8Array(32);
  const api = cryptoApi(win);
  if (api?.getRandomValues) {
    api.getRandomValues(bytes);
    return base64Url(bytes);
  }
  const rng = Cc['@mozilla.org/security/random-generator;1'].createInstance(Ci.nsIRandomGenerator);
  let raw;
  try {
    raw = rng.generateRandomBytes(32);
  } catch (e) {
    const out = {};
    rng.generateRandomBytes(32, out);
    raw = out.value;
  }
  if (typeof raw === 'string') raw = Array.from(raw, (ch) => ch.charCodeAt(0));
  return base64Url(raw);
}

async function codeChallenge(win, verifier) {
  const data = new TextEncoder().encode(verifier);
  const api = cryptoApi(win);
  if (api?.subtle?.digest) {
    const digest = await api.subtle.digest('SHA-256', data);
    return base64Url(new Uint8Array(digest));
  }
  const hasher = Cc['@mozilla.org/security/crypto-hash;1'].createInstance(Ci.nsICryptoHash);
  hasher.init(Ci.nsICryptoHash.SHA256);
  try {
    hasher.update(data, data.length);
  } catch (e) {
    let binary = '';
    for (const value of data) binary += String.fromCharCode(value);
    hasher.update(binary, binary.length);
  }
  return hasher.finish(true).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function formEncode(fields) {
  return Object.entries(fields)
    .filter(([, value]) => value != null && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

function profileFile() {
  const profileDir = Services.dirsvc.get('ProfD', Ci.nsIFile).path;
  return PathUtils.join(profileDir, CONFIG.GOOGLE_TOKEN_FILE);
}

async function loadTokens() {
  if (tokenStore) return tokenStore;
  try {
    const parsed = await IOUtils.readJSON(profileFile());
    tokenStore = parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    tokenStore = {};
  }
  return tokenStore;
}

function saveTokens(store) {
  tokenStore = store;
  const path = profileFile();
  tokenWrite = tokenWrite.then(() => IOUtils.writeJSON(path, store, { tmpPath: path + '.tmp' })).catch((e) => {
    debugLog('Calendar token save failed', e && e.message ? e.message : e);
  });
  return tokenWrite;
}

async function tokenFor(contextKey) {
  const store = await loadTokens();
  return store[contextKey]?.accessToken ? store[contextKey] : null;
}

async function putToken(contextKey, payload, previous) {
  const store = await loadTokens();
  const expiresIn = Number(payload.expires_in) || 3600;
  store[contextKey] = {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || previous?.refreshToken || '',
    expiresAt: Date.now() + expiresIn * 1000,
    scope: payload.scope || CALENDAR_SCOPE
  };
  await saveTokens(store);
  return store[contextKey];
}

async function dropToken(contextKey) {
  const store = await loadTokens();
  if (!store[contextKey]) return;
  delete store[contextKey];
  await saveTokens(store);
}

export async function clearGoogleTokens() {
  await saveTokens({});
}

async function rememberGoogle(win, userContextId, token) {
  try {
    const fetched = await googleFetch(win, {
      url: 'https://www.googleapis.com/oauth2/v1/userinfo',
      userContextId,
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }
    });
    const payload = JSON.parse(fetched.text || '{}');
    if (payload.email) await setAccountEmail('google', payload.email);
  } catch (e) {}
}

function googleFetch(win, { url, method = 'GET', headers = {}, body = '', contentType, userContextId }) {
  const uri = Services.io.newURI(url);
  const principal = Services.scriptSecurityManager.createContentPrincipal(uri, {
    userContextId: userContextId || 0
  });
  const channel = NetUtil.newChannel({
    uri,
    loadingPrincipal: principal,
    triggeringPrincipal: principal,
    contentPolicyType: Ci.nsIContentPolicy.TYPE_XMLHTTPREQUEST,
    securityFlags: Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_INHERITS_SEC_CONTEXT
  }).QueryInterface(Ci.nsIHttpChannel);

  if (body) {
    const stream = Cc['@mozilla.org/io/string-input-stream;1'].createInstance(Ci.nsIStringInputStream);
    if (typeof stream.setUTF8Data === 'function') stream.setUTF8Data(body);
    else stream.setByteStringData(body);
    channel.QueryInterface(Ci.nsIUploadChannel);
    channel.setUploadStream(stream, contentType || 'application/json; charset=utf-8', -1);
  }
  channel.requestMethod = method;
  channel.loadFlags |= Ci.nsIRequest.LOAD_BYPASS_CACHE | Ci.nsIRequest.INHIBIT_CACHING | Ci.nsIRequest.LOAD_ANONYMOUS;
  for (const [name, value] of Object.entries(headers)) {
    if (value == null || value === '') continue;
    try { channel.setRequestHeader(name, String(value), false); } catch (e) {}
  }

  let channelId = 0;
  try { channelId = channel.QueryInterface(Ci.nsIIdentChannel).channelId; } catch (e) {}
  const observer = {
    observe(subject) {
      if (!channelId) return;
      try {
        const ident = subject.QueryInterface(Ci.nsIIdentChannel);
        if (ident.channelId !== channelId) return;
        const http = subject.QueryInterface(Ci.nsIHttpChannel);
        if (headers.Authorization) http.setRequestHeader('Authorization', headers.Authorization, false);
        const spec = http.URI?.spec || '';
        if (spec.startsWith(TOKEN_URL)) {
          http.setRequestHeader('Origin', '', false);
          http.setRequestHeader('Referer', '', false);
        }
      } catch (e) {}
    }
  };
  Services.obs.addObserver(observer, 'http-on-modify-request');
  try { Services.obs.addObserver(observer, 'http-on-before-connect'); } catch (e) {}
  const stopObserving = () => {
    try { Services.obs.removeObserver(observer, 'http-on-modify-request'); } catch (e) {}
    try { Services.obs.removeObserver(observer, 'http-on-before-connect'); } catch (e) {}
  };

  return new Promise((resolve, reject) => {
    const timer = win.setTimeout(() => {
      try { channel.cancel(Cr.NS_ERROR_NET_TIMEOUT); } catch (e) {}
    }, CONFIG.REQUEST_TIMEOUT_MS);
    NetUtil.asyncFetch(channel, (input, requestStatus, request) => {
      win.clearTimeout(timer);
      stopObserving();
      if (!Components.isSuccessCode(requestStatus)) {
        reject(new Error('Network error'));
        return;
      }
      let text = '';
      try {
        const available = input.available();
        if (available > 0) {
          text = NetUtil.readInputStreamToString(input, Math.min(available, 1000000), { charset: 'UTF-8' });
        }
      } catch (e) {}
      let status = 0;
      try { status = request.QueryInterface(Ci.nsIHttpChannel).responseStatus; } catch (e) {}
      resolve({ status, text });
    });
  });
}

async function postToken(win, userContextId, fields) {
  const fetched = await googleFetch(win, {
    url: TOKEN_URL,
    userContextId,
    method: 'POST',
    contentType: 'application/x-www-form-urlencoded;charset=UTF-8',
    headers: { Accept: 'application/json' },
    body: formEncode(fields)
  });
  let payload = {};
  try { payload = JSON.parse(fetched.text || '{}'); } catch (e) {}
  return { status: fetched.status, payload };
}

async function refreshToken(win, userContextId, contextKey, entry, clientId) {
  const current = entry || await tokenFor(contextKey);
  if (!current?.refreshToken) return null;
  const { status, payload } = await postToken(win, userContextId, tokenFields({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: current.refreshToken
  }));
  if (status < 200 || status >= 300 || !payload.access_token) {
    debugLog('Calendar refresh failed', status, payload.error || '');
    await dropToken(contextKey);
    await markExpired('google');
    return null;
  }
  return putToken(contextKey, payload, current);
}

async function accessToken(win, userContextId, contextKey, clientId) {
  let entry = await tokenFor(contextKey);
  if (!entry) return null;
  if (entry.expiresAt && entry.expiresAt - TOKEN_SKEW_MS > Date.now()) return entry.accessToken;
  entry = await refreshToken(win, userContextId, contextKey, entry, clientId);
  return entry?.accessToken || null;
}

function rfc3339(date) {
  const pad = (value) => String(value).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function todayWindow() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + 86400000);
  return { timeMin: rfc3339(start), timeMax: rfc3339(end) };
}

function payloadError(text) {
  try { return JSON.parse(text || '{}'); } catch (e) { return {}; }
}

function apiMessage(status, payload) {
  const err = payload?.error;
  const reason = err?.errors?.[0]?.reason || '';
  const message = err?.message || payload?.error_description || (typeof err === 'string' ? err : '');
  if (reason === 'accessNotConfigured' || /has not been used|is disabled/i.test(message || '')) {
    return 'Enable the Google Calendar API for this app';
  }
  if (message) return message;
  return 'Calendar HTTP ' + status;
}

function joinUrlFrom(item) {
  if (item?.hangoutLink) return item.hangoutLink;
  const points = item?.conferenceData?.entryPoints || [];
  const video = points.find((point) => point?.uri && (point.entryPointType === 'video' || /meet\.google|zoom\.|teams\./i.test(point.uri)));
  if (video?.uri) return video.uri;
  return findCallUrl(item?.location, item?.description);
}

function rowsFromPayload(payload) {
  const rows = [];
  for (const item of payload?.items || []) {
    if (!item || item.status === 'cancelled') continue;
    const allDay = !!item.start?.date && !item.start?.dateTime;
    const start = allDay ? item.start.date : item.start?.dateTime;
    const end = allDay ? (item.end?.date || '') : (item.end?.dateTime || '');
    if (!start) continue;
    rows.push({
      title: item.summary || 'Busy',
      allDay,
      start,
      end,
      htmlLink: item.htmlLink || '',
      joinUrl: allDay ? '' : joinUrlFrom(item)
    });
  }
  return rows;
}

async function calendarGet(win, userContextId, token, url) {
  const fetched = await googleFetch(win, {
    url,
    userContextId,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/json'
    }
  });
  const payload = payloadError(fetched.text);
  return { status: fetched.status, payload };
}

function eventsUrl(calendarId, window) {
  const params = new URLSearchParams({
    timeMin: window.timeMin,
    timeMax: window.timeMax,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '50',
    fields: 'items(id,status,summary,start,end,htmlLink,hangoutLink,location,description,conferenceData/entryPoints)'
  });
  return `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`;
}

async function selectedCalendarIds(win, userContextId, token) {
  const fetched = await calendarGet(
    win,
    userContextId,
    token,
    'https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader&maxResults=50&fields=items(id,selected,primary)'
  );
  if (fetched.status === 401) return { unauthorized: true, ids: [] };
  if (fetched.status < 200 || fetched.status >= 300) {
    throw new Error(apiMessage(fetched.status, fetched.payload));
  }
  const ids = [];
  let primary = '';
  for (const item of fetched.payload.items || []) {
    if (!item?.id) continue;
    if (item.primary) primary = item.id;
    if (item.selected === true || item.primary === true) ids.push(item.id);
  }
  const ordered = primary ? [primary, ...ids.filter((id) => id !== primary)] : ids;
  return { unauthorized: false, ids: ordered.length ? ordered.slice(0, MAX_CALENDARS) : ['primary'] };
}

async function eventsForCalendar(win, userContextId, token, calendarId, bounds) {
  const fetched = await calendarGet(win, userContextId, token, eventsUrl(calendarId, bounds));
  if (fetched.status === 401) return { unauthorized: true, rows: [] };
  if (fetched.status === 404) return { unauthorized: false, rows: [] };
  if (fetched.status < 200 || fetched.status >= 300) {
    debugLog('Calendar skip', calendarId, fetched.status, apiMessage(fetched.status, fetched.payload));
    return { unauthorized: false, rows: [] };
  }
  return { unauthorized: false, rows: rowsFromPayload(fetched.payload) };
}

function mergeRows(groups) {
  const seen = new Set();
  const rows = [];
  for (const group of groups) {
    for (const row of group) {
      const key = `${row.start}|${row.title}|${row.htmlLink}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
  }
  return rows;
}

async function loadDay(win, userContextId, token) {
  const bounds = todayWindow();
  let list = await selectedCalendarIds(win, userContextId, token);
  if (list.unauthorized) return { unauthorized: true, rows: [] };
  const groups = [];
  for (const calendarId of list.ids) {
    const batch = await eventsForCalendar(win, userContextId, token, calendarId, bounds);
    if (batch.unauthorized) return { unauthorized: true, rows: [] };
    groups.push(batch.rows);
  }
  return { unauthorized: false, rows: mergeRows(groups) };
}

export async function fetchGoogleDay(win, tab, contextKey) {
  const clientId = readGoogleClientId();
  const state = googleClientState(clientId);
  if (state !== 'ok') throw signInError(googleSignInMessage(state), false);
  const userContextId = getTabUserContextId(tab);
  let bearer = await accessToken(win, userContextId, contextKey, clientId);
  if (!bearer) {
    if (isExpired('google')) {
      const error = signInError('Reconnect Google Calendar', true);
      error.expired = true;
      throw error;
    }
    throw signInError(googleSignInMessage('ok'), false);
  }

  let day = await loadDay(win, userContextId, bearer);
  if (day.unauthorized) {
    const entry = await tokenFor(contextKey);
    const refreshed = await refreshToken(win, userContextId, contextKey, entry, clientId);
    bearer = refreshed?.accessToken || '';
    if (!bearer) {
      const error = signInError('Reconnect Google Calendar', true);
      error.expired = true;
      throw error;
    }
    day = await loadDay(win, userContextId, bearer);
  }
  if (day.unauthorized) throw signInError(googleSignInMessage('ok'), true);
  debugLog('Calendar', localDay(), day.rows.length, 'events', contextKey);
  return day.rows;
}

function tabIsOpen(tab) {
  return !!(tab && tab.isConnected && tab.linkedBrowser);
}

function readHeaders(input) {
  return new Promise((resolve, reject) => {
    let data = '';
    const sink = {
      onInputStreamReady(stream) {
        try {
          let available = 0;
          try { available = stream.available(); } catch (e) {
            resolve(data);
            return;
          }
          if (available > 0) {
            data += NetUtil.readInputStreamToString(stream, Math.min(available, 8192));
          }
          if (data.includes('\r\n\r\n') || data.length >= 8192) {
            resolve(data);
            return;
          }
          stream.asyncWait(sink, 0, 0, Services.tm.mainThread);
        } catch (e) {
          if (data) resolve(data);
          else reject(e);
        }
      }
    };
    try {
      input.asyncWait(sink, 0, 0, Services.tm.mainThread);
    } catch (e) {
      reject(e);
    }
  });
}

function replyHtml(output, page) {
  const body = page || '<!DOCTYPE html><title>Zen Calendar</title><p>Signed in. This tab will close.</p>';
  const head = `HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`;
  try { output.write(head, head.length); } catch (e) {}
  try { output.close(); } catch (e) {}
}

function startLoopback(win, state) {
  const server = Cc['@mozilla.org/network/server-socket;1'].createInstance(Ci.nsIServerSocket);
  server.init(-1, true, 4);
  const redirectUri = `http://127.0.0.1:${server.port}`;
  let settled = false;
  let resolve;
  let reject;
  const result = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const timer = win.setTimeout(() => {
    finish(() => reject(new Error('Google did not return a code. Create the client as a Desktop app.')));
  }, AUTH_TIMEOUT_MS);

  function finish(done) {
    if (settled) return;
    settled = true;
    win.clearTimeout(timer);
    try { server.close(); } catch (e) {}
    done();
  }

  const listener = {
    onSocketAccepted(_sock, transport) {
      const rawInput = transport.openInputStream(0, 0, 0);
      const output = transport.openOutputStream(0, 0, 0);
      const input = rawInput.QueryInterface(Ci.nsIAsyncInputStream);
      readHeaders(input).then((raw) => {
        const line = String(raw || '').split('\r\n')[0] || '';
        const path = (line.match(/^GET\s+(\S+)/i) || [])[1] || '/';
        let url;
        try { url = new URL(path, redirectUri); } catch (e) { url = null; }
        const code = url?.searchParams.get('code') || '';
        const error = url?.searchParams.get('error') || '';
        const returned = url?.searchParams.get('state') || '';
        if (!code && !error) {
          replyHtml(output, '<!DOCTYPE html><title>Zen Calendar</title>');
          try { input.close(); } catch (e) {}
          return;
        }
        replyHtml(output);
        try { input.close(); } catch (e) {}
        if (returned !== state) {
          finish(() => reject(new Error('Google sign-in state did not match')));
          return;
        }
        if (error) {
          const message = error === 'access_denied' ? 'Google sign-in was cancelled' : error;
          finish(() => reject(new Error(message)));
          return;
        }
        finish(() => resolve(code));
      }).catch(() => {
        try { output.close(); } catch (e) {}
      });
    },
    onStopListening() {}
  };
  server.asyncListen(listener);
  return {
    redirectUri,
    result,
    stop() {
      finish(() => reject(new Error('Google sign-in closed')));
    }
  };
}

function authorizeUrl({ clientId, redirectUri, state, challenge }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: CALENDAR_SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    access_type: 'offline',
    prompt: 'consent select_account'
  });
  return `${AUTHORIZE_URL}?${params}`;
}

export async function beginGoogleSignIn(app, tab, contextKey) {
  const clientId = readGoogleClientId();
  if (googleClientState(clientId) !== 'ok') return;
  if (authInFlight.has(contextKey)) return;
  authInFlight.add(contextKey);
  const win = app.window;
  const userContextId = getTabUserContextId(tab);
  let authTab = null;
  let loopback = null;
  try {
    if (!win?.gBrowser?.addTab) throw new Error('Zen tab browser is missing');
    const verifier = randomToken(win);
    const state = randomToken(win);
    loopback = startLoopback(win, state);
    const url = authorizeUrl({
      clientId,
      redirectUri: loopback.redirectUri,
      state,
      challenge: await codeChallenge(win, verifier)
    });
    const addTabArgs = {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      inBackground: false
    };
    if (userContextId) addTabArgs.userContextId = userContextId;
    authTab = win.gBrowser.addTab(url, addTabArgs);
    win.gBrowser.selectedTab = authTab;
    const redirectUri = loopback.redirectUri;
    authTab.addEventListener('TabClose', () => loopback.stop());
    await new Promise((resolve) => win.setTimeout(resolve, 0));
    if (!tabIsOpen(authTab)) throw new Error('Zen closed the sign-in tab before it opened');
    app.panel.hide();
    const code = await loopback.result;
    try { win.gBrowser.removeTab(authTab); } catch (e) {}
    authTab = null;
    const { status, payload } = await postToken(win, userContextId, tokenFields({
      client_id: clientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier
    }));
    if (status < 200 || status >= 300 || !payload.access_token) {
      throw signInError(tokenError(payload), true);
    }
    await putToken(contextKey, payload, null);
    await markConnected('google', contextKey);
    await rememberGoogle(win, userContextId, payload.access_token);
    app.setNotice(contextKey, null);
    debugLog('Calendar signed in', contextKey);
    if (tab) app.refreshDay(tab, { force: true });
  } catch (e) {
    console.warn('[Live Calendar] Google sign-in failed:', e && e.message ? e.message : e);
    await setAccountMessage('google', e?.message || 'Google sign-in failed');
    app.setNotice?.(contextKey, null);
  } finally {
    authInFlight.delete(contextKey);
    if (loopback) {
      loopback.result.catch(() => {});
      try { loopback.stop(); } catch (e) {}
    }
    if (authTab) {
      try { win.gBrowser.removeTab(authTab); } catch (e) {}
    }
  }
}
