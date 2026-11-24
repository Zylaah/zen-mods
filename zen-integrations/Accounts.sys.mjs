const { profilePath } = ChromeUtils.importESModule(
  'chrome://sine/content/zen-integrations/Util.sys.mjs' + new URL(import.meta.url).search
);

const FILE = 'zen-integrations-accounts.json';
const GOOGLE_TOKEN_FILE = 'live-calendar-google-tokens.json';
const OUTLOOK_TOKEN_FILE = 'zen-integrations-outlook-tokens.json';

let memory = null;
let loading = null;
let writing = Promise.resolve();

function blank(id = '', provider = '') {
  return {
    id: String(id || ''),
    provider,
    enabled: false,
    expired: false,
    hasToken: false,
    email: '',
    label: '',
    contextKey: String(id || ''),
    message: ''
  };
}

function profileFile() {
  return profilePath(FILE);
}

function containerOf(key) {
  const parts = String(key || '').split(':');
  return parseInt(parts[parts.length - 1] || '0', 10) || 0;
}

export function providerOf(id) {
  const key = String(id || '');
  if (key.startsWith('gmail:') || key === 'google') return 'google';
  if (key.startsWith('outlook:') || key === 'outlook') return 'outlook';
  return '';
}

export function googleAccountId(contextKey) {
  return 'gmail:' + containerOf(contextKey);
}

export function outlookAccountId(contextKey) {
  const key = String(contextKey || '');
  if (key.startsWith('outlook:')) return key;
  return 'outlook:office:' + containerOf(key);
}

function normalizeAccount(id, raw, provider) {
  const fallbackProvider = provider || providerOf(id) || raw?.provider || '';
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    ...blank(id, fallbackProvider),
    ...source,
    id: String(id || source.id || ''),
    provider: fallbackProvider,
    contextKey: String(source.contextKey || id || '')
  };
}

function normalize(store) {
  const source = store && typeof store === 'object' ? store : {};
  const accounts = {};
  if (source.accounts && typeof source.accounts === 'object') {
    for (const [id, raw] of Object.entries(source.accounts)) {
      const provider = raw?.provider || providerOf(id);
      if (!provider) continue;
      accounts[id] = normalizeAccount(id, raw, provider);
    }
  }
  return { version: 2, accounts };
}

function save(store) {
  const next = normalize(store);
  memory = next;
  const path = profileFile();
  writing = writing.then(() => IOUtils.writeJSON(path, next, { tmpPath: path + '.tmp' })).catch(() => {});
  return writing;
}

async function readTokenMap(name) {
  try {
    const parsed = await IOUtils.readJSON(profilePath(name));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    return {};
  }
}

async function migrateLegacy(store) {
  const accounts = {};
  const googleTokens = await readTokenMap(GOOGLE_TOKEN_FILE);
  const outlookTokens = await readTokenMap(OUTLOOK_TOKEN_FILE);

  const add = (record) => {
    const provider = record.provider || providerOf(record.id);
    if (!provider) return;
    const container = containerOf(record.id);
    const existingKey = Object.keys(accounts).find((key) => {
      const current = accounts[key];
      return current.provider === provider && containerOf(key) === container;
    });
    const key = existingKey || record.id;
    const current = accounts[key] || blank(key, provider);
    const next = {
      ...current,
      ...record,
      id: key,
      provider,
      contextKey: record.contextKey || current.contextKey || key,
      enabled: !!(current.enabled || record.enabled),
      hasToken: !!(current.hasToken || record.hasToken),
      expired: record.expired != null ? !!record.expired : !!current.expired,
      email: record.email || current.email || '',
      label: record.label || current.label || '',
      message: record.message || current.message || ''
    };
    accounts[key] = normalizeAccount(key, next, provider);
  };

  for (const [key, entry] of Object.entries(googleTokens)) {
    if (!entry?.accessToken && !entry?.refreshToken) continue;
    const id = googleAccountId(key);
    add({ id, provider: 'google', contextKey: id, enabled: true, hasToken: true });
  }
  for (const [key, entry] of Object.entries(outlookTokens)) {
    if (!entry?.accessToken && !entry?.refreshToken) continue;
    const id = outlookAccountId(key);
    add({ id, provider: 'outlook', contextKey: id, enabled: true, hasToken: true });
  }

  const legacyGoogle = store?.google;
  if (legacyGoogle && typeof legacyGoogle === 'object') {
    const id = googleAccountId(legacyGoogle.contextKey || 0);
    add({
      id,
      provider: 'google',
      contextKey: id,
      enabled: !!legacyGoogle.enabled,
      expired: !!legacyGoogle.expired,
      hasToken: !!legacyGoogle.hasToken,
      email: legacyGoogle.email || '',
      label: legacyGoogle.label || '',
      message: legacyGoogle.message || ''
    });
  }

  const legacyOutlook = store?.outlook;
  if (legacyOutlook && typeof legacyOutlook === 'object') {
    const id = outlookAccountId(legacyOutlook.contextKey || 0);
    add({
      id,
      provider: 'outlook',
      contextKey: id,
      enabled: !!legacyOutlook.enabled,
      expired: !!legacyOutlook.expired,
      hasToken: !!legacyOutlook.hasToken,
      email: legacyOutlook.email || '',
      label: legacyOutlook.label || '',
      message: legacyOutlook.message || ''
    });
  }

  return { version: 2, accounts };
}

export function loadAccounts() {
  if (memory) return Promise.resolve(memory);
  if (loading) return loading;
  loading = (async () => {
    let parsed = null;
    try {
      parsed = await IOUtils.readJSON(profileFile());
    } catch (e) {}
    if (parsed?.version === 2 && parsed.accounts && typeof parsed.accounts === 'object') {
      memory = normalize(parsed);
    } else {
      memory = await migrateLegacy(parsed);
      await save(memory);
    }
    return memory;
  })().finally(() => {
    loading = null;
  });
  return loading;
}

function storeAccounts() {
  return memory?.accounts && typeof memory.accounts === 'object' ? memory.accounts : {};
}

export function resolveAccountId(id) {
  const key = String(id || '');
  const accounts = storeAccounts();
  if (accounts[key]) return key;
  const provider = providerOf(key);
  if (!provider) return '';
  const container = containerOf(key);
  for (const [accountId, record] of Object.entries(accounts)) {
    if (record.provider !== provider) continue;
    if (containerOf(accountId) === container) return accountId;
  }
  return '';
}

function account(id) {
  const key = resolveAccountId(id);
  return key ? storeAccounts()[key] || null : null;
}

export function isEnabled(id) {
  return !!account(id)?.enabled;
}

export function isExpired(id) {
  const record = account(id);
  return !!record?.enabled && !!record?.expired;
}

export function hasToken(id) {
  return !!account(id)?.hasToken;
}

export function accountRecord(id) {
  const record = account(id);
  if (!record) return blank(String(id || ''), providerOf(id));
  return { ...record };
}

export function listAccounts(provider = '') {
  const items = Object.values(storeAccounts()).map((record) => ({ ...record }));
  const filtered = provider ? items.filter((record) => record.provider === provider) : items;
  return filtered.sort((left, right) => {
    const leftName = left.label || left.email || left.id;
    const rightName = right.label || right.email || right.id;
    return leftName.localeCompare(rightName);
  });
}

export function accountForContainer(provider, container) {
  const wanted = Number(container) || 0;
  for (const record of Object.values(storeAccounts())) {
    if (record.provider !== provider) continue;
    if (containerOf(record.id) === wanted) return { ...record };
  }
  return null;
}

async function update(id, patch) {
  const store = await loadAccounts();
  const key = resolveAccountId(id) || String(id || '');
  const provider = providerOf(key);
  if (!provider) return blank(key, '');
  const current = store.accounts[key] || blank(key, provider);
  store.accounts[key] = normalizeAccount(key, { ...current, ...patch }, provider);
  await save(store);
  return store.accounts[key];
}

export function markConnected(id, contextKey) {
  return update(id, {
    enabled: true,
    expired: false,
    hasToken: true,
    contextKey: contextKey || id,
    message: ''
  });
}

export function setAccountEmail(id, email) {
  return update(id, { email: email || '' });
}

export function setAccountLabel(id, label) {
  return update(id, { label: label || '' });
}

export function setAccountMessage(id, message) {
  return update(id, { message: message || '' });
}

export function markExpired(id) {
  return update(id, { expired: true, hasToken: false, message: '' });
}

export function disconnectAccount(id) {
  return update(id, { enabled: false, expired: false, hasToken: false, message: '' });
}

export async function removeAccount(id) {
  const store = await loadAccounts();
  const key = resolveAccountId(id) || String(id || '');
  if (!key || !store.accounts[key]) return;
  delete store.accounts[key];
  await save(store);
}
