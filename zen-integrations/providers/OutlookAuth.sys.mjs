const { CONFIG, debugLog, getTabUserContextId, httpRequest, profilePath } = ChromeUtils.importESModule(
  'chrome://sine/content/zen-integrations/Util.sys.mjs' + new URL(import.meta.url).search
);
const {
  OUTLOOK_REDIRECT_URI,
  OUTLOOK_SCOPE,
  OUTLOOK_TOKEN_URL,
  authorizeUrl,
  formEncode,
  graphMessagesUrl,
  graphUnreadRows,
  outlookClientState
} = ChromeUtils.importESModule(
  'chrome://sine/content/zen-integrations/providers/OutlookGraph.sys.mjs' + new URL(import.meta.url).search
);

const TOKEN_SKEW_MS = 60000;
const AUTH_TIMEOUT_MS = 180000;

let tokenStore = null;
let tokenWrite = Promise.resolve();
const authInFlight = new Set();

export function readOutlookClientId() {
  try {
    return Services.prefs.getStringPref(CONFIG.OUTLOOK_CLIENT_PREF, '').trim();
  } catch (e) {
    return '';
  }
}

export function outlookSignInMessage() {
  const state = outlookClientState(readOutlookClientId());
  if (state === 'foreign') return "Use your own Microsoft app id. This one belongs to Arc.";
  if (state === 'invalid') return 'zen-integrations.outlook.clientId is not a Microsoft app id';
  if (state === 'ok') return 'Click to sign in to Outlook';
  return '';
}

function signInError(message) {
  const error = new Error(message || 'Sign-in required');
  error.signin = true;
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

async function loadTokens() {
  if (tokenStore) return tokenStore;
  try {
    const parsed = await IOUtils.readJSON(profilePath(CONFIG.OUTLOOK_TOKEN_FILE));
    tokenStore = parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    tokenStore = {};
  }
  return tokenStore;
}

function saveTokens(store) {
  tokenStore = store;
  const path = profilePath(CONFIG.OUTLOOK_TOKEN_FILE);
  tokenWrite = tokenWrite.then(() => IOUtils.writeJSON(path, store, { tmpPath: path + '.tmp' })).catch((e) => {
    debugLog('Outlook token save failed', e && e.message ? e.message : e);
  });
  return tokenWrite;
}

const CONSUMER_OUTLOOK_FAMILIES = new Set(['live', 'cloud']);

function outlookKeyParts(contextKey) {
  const parts = String(contextKey || '').split(':');
  return {
    family: parts[1] || '',
    container: parts[parts.length - 1] || '0'
  };
}

function tokenStorageKey(store, contextKey) {
  if (store[contextKey]?.accessToken) return contextKey;
  const wanted = outlookKeyParts(contextKey);
  if (!CONSUMER_OUTLOOK_FAMILIES.has(wanted.family)) return '';
  for (const key of Object.keys(store)) {
    const other = outlookKeyParts(key);
    if (other.container !== wanted.container) continue;
    if (!CONSUMER_OUTLOOK_FAMILIES.has(other.family)) continue;
    if (store[key]?.accessToken) return key;
  }
  return '';
}

async function resolveToken(contextKey) {
  const store = await loadTokens();
  const key = tokenStorageKey(store, contextKey);
  if (!key) return null;
  if (key !== contextKey) debugLog('Outlook token reused', key, 'for', contextKey);
  return { key, entry: store[key] };
}

async function tokenFor(contextKey) {
  const found = await resolveToken(contextKey);
  return found?.entry || null;
}

async function putToken(contextKey, payload, previous) {
  const store = await loadTokens();
  const expiresIn = Number(payload.expires_in) || 3600;
  store[contextKey] = {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || previous?.refreshToken || '',
    expiresAt: Date.now() + expiresIn * 1000,
    scope: payload.scope || OUTLOOK_SCOPE
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

async function postToken(win, userContextId, fields) {
  const fetched = await httpRequest(win, {
    url: OUTLOOK_TOKEN_URL,
    userContextId,
    method: 'POST',
    anonymous: true,
    contentType: 'application/x-www-form-urlencoded;charset=UTF-8',
    headers: { Accept: 'application/json' },
    body: formEncode(fields)
  });
  let payload = {};
  try { payload = JSON.parse(fetched.text || '{}'); } catch (e) {}
  return { status: fetched.status, payload };
}

async function refreshToken(win, userContextId, contextKey, entry, clientId) {
  const found = await resolveToken(contextKey);
  const key = found?.key || contextKey;
  const current = entry || found?.entry;
  if (!current?.refreshToken) return null;
  const { status, payload } = await postToken(win, userContextId, {
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: current.refreshToken,
    scope: OUTLOOK_SCOPE
  });
  if (status < 200 || status >= 300 || !payload.access_token) {
    debugLog('Outlook refresh failed', status, payload.error || '');
    await dropToken(key);
    return null;
  }
  return putToken(key, payload, current);
}

async function accessToken(win, userContextId, contextKey, clientId) {
  let entry = await tokenFor(contextKey);
  if (!entry) return null;
  if (entry.expiresAt && entry.expiresAt - TOKEN_SKEW_MS > Date.now()) return entry.accessToken;
  entry = await refreshToken(win, userContextId, contextKey, entry, clientId);
  return entry?.accessToken || null;
}

function tabIsOpen(tab) {
  return !!(tab && tab.isConnected && tab.linkedBrowser);
}

function waitForAuthCode(win, tab, state) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let browser = null;
    let armTimer = 0;
    const listener = {
      QueryInterface: ChromeUtils.generateQI(['nsIWebProgressListener', 'nsISupportsWeakReference']),
      onLocationChange(_progress, _request, location) {
        let spec = '';
        try { spec = location?.spec || ''; } catch (e) { return; }
        if (!spec.startsWith(OUTLOOK_REDIRECT_URI)) return;
        let parsed;
        try { parsed = new URL(spec); } catch (e) { return; }
        if (parsed.searchParams.get('state') !== state) return;
        const error = parsed.searchParams.get('error');
        const code = parsed.searchParams.get('code');
        if (error) {
          finish(() => reject(new Error(parsed.searchParams.get('error_description') || error)));
          return;
        }
        if (!code) {
          finish(() => reject(new Error('Microsoft sign-in returned no code')));
          return;
        }
        finish(() => resolve(code));
      }
    };
    const timer = win.setTimeout(() => {
      finish(() => reject(new Error('Microsoft sign-in timed out')));
    }, AUTH_TIMEOUT_MS);
    const onClose = () => finish(() => reject(new Error('Microsoft sign-in closed')));
    function finish(done) {
      if (settled) return;
      settled = true;
      win.clearTimeout(timer);
      win.clearTimeout(armTimer);
      try { browser?.removeProgressListener(listener); } catch (e) {}
      try { tab.removeEventListener('TabClose', onClose); } catch (e) {}
      try { win.gBrowser.removeTab(tab); } catch (e) {}
      done();
    }
    function arm(tries) {
      if (settled) return;
      if (!tab.isConnected) {
        finish(() => reject(new Error('Zen closed the sign-in tab')));
        return;
      }
      browser = tab.linkedBrowser || null;
      if (!browser) {
        if (tries > 40) {
          finish(() => reject(new Error('Zen did not attach a browser to the sign-in tab')));
          return;
        }
        armTimer = win.setTimeout(() => arm(tries + 1), 50);
        return;
      }
      tab.addEventListener('TabClose', onClose);
      try {
        browser.addProgressListener(listener, Ci.nsIWebProgress.NOTIFY_LOCATION);
      } catch (e) {
        finish(() => reject(e));
      }
    }
    arm(0);
  });
}

export async function beginOutlookSignIn(app, tab, contextKey) {
  const clientId = readOutlookClientId();
  const stateName = outlookClientState(clientId);
  if (stateName !== 'ok') return;
  if (authInFlight.has(contextKey)) return;
  authInFlight.add(contextKey);
  const win = app.window;
  const userContextId = getTabUserContextId(tab);
  let authTab = null;
  try {
    if (!win?.gBrowser?.addTab) throw new Error('Zen tab browser is missing');
    const verifier = randomToken(win);
    const state = randomToken(win);
    const url = authorizeUrl({
      clientId,
      redirectUri: OUTLOOK_REDIRECT_URI,
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
    await new Promise((resolve) => win.setTimeout(resolve, 0));
    if (!tabIsOpen(authTab)) throw new Error('Zen closed the sign-in tab before it opened');
    app.panel.hide();
    const code = await waitForAuthCode(win, authTab, state);
    authTab = null;
    const { status, payload } = await postToken(win, userContextId, {
      client_id: clientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: OUTLOOK_REDIRECT_URI,
      code_verifier: verifier,
      scope: OUTLOOK_SCOPE
    });
    if (status < 200 || status >= 300 || !payload.access_token) {
      throw signInError(payload.error_description || payload.error || 'Microsoft token request failed');
    }
    await putToken(contextKey, payload, null);
    debugLog('Outlook signed in', contextKey);
    app.scan.requestScan(tab, { force: true });
  } catch (e) {
    console.warn('[Zen Integrations] Outlook sign-in failed:', e && e.message ? e.message : e);
    debugLog('Outlook sign-in failed', e && e.message ? e.message : e);
    if (app.activePanelContextKey === contextKey) {
      app.panel.showError(e?.message || 'Microsoft sign-in failed', { signin: true });
    }
  } finally {
    authInFlight.delete(contextKey);
    if (authTab) {
      try { win.gBrowser.removeTab(authTab); } catch (e) {}
    }
  }
}

export async function fetchOutlookGraph(app, tab, contextKey) {
  const clientId = readOutlookClientId();
  const stateName = outlookClientState(clientId);
  if (stateName === 'foreign') throw signInError(outlookSignInMessage());
  if (stateName === 'invalid') throw signInError(outlookSignInMessage());
  if (stateName !== 'ok') return null;

  const win = app.window;
  const userContextId = getTabUserContextId(tab);
  let bearer = await accessToken(win, userContextId, contextKey, clientId);
  if (!bearer) throw signInError(outlookSignInMessage());

  const load = (token) => httpRequest(win, {
    url: graphMessagesUrl(),
    userContextId,
    method: 'GET',
    anonymous: true,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/json'
    },
    maxBytes: 2000000
  });

  let fetched = await load(bearer);
  if (fetched.status === 401) {
    const entry = await tokenFor(contextKey);
    const refreshed = await refreshToken(win, userContextId, contextKey, entry, clientId);
    bearer = refreshed?.accessToken || '';
    if (!bearer) throw signInError(outlookSignInMessage());
    fetched = await load(bearer);
  }
  if (fetched.status === 401 || fetched.status === 403) throw signInError(outlookSignInMessage());
  if (fetched.status < 200 || fetched.status >= 300) {
    let detail = '';
    try { detail = JSON.parse(fetched.text || '{}').error?.message || ''; } catch (e) {}
    throw new Error(detail ? 'Graph HTTP ' + fetched.status + ': ' + detail : 'Graph HTTP ' + fetched.status);
  }
  let payload = {};
  try { payload = JSON.parse(fetched.text || '{}'); } catch (e) {
    throw new Error('Graph response was not JSON');
  }
  if (payload.error) throw new Error(payload.error.message || payload.error.code || 'Graph error');
  debugLog('Outlook Graph', fetched.status, (payload.value || []).length);
  return graphUnreadRows(payload, CONFIG.MAX_EMAILS);
}
