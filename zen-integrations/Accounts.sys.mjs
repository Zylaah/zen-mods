const FILE = 'zen-integrations-accounts.json';

let memory = null;
let writing = Promise.resolve();

function blank(enabled = false) {
  return { enabled, expired: false, hasToken: enabled, email: '', contextKey: '', message: '' };
}

function profileFile() {
  const profileDir = Services.dirsvc.get('ProfD', Ci.nsIFile).path;
  return PathUtils.join(profileDir, FILE);
}

async function fileHasToken(name) {
  try {
    const path = PathUtils.join(Services.dirsvc.get('ProfD', Ci.nsIFile).path, name);
    const parsed = await IOUtils.readJSON(path);
    return Object.values(parsed || {}).some((entry) => entry?.accessToken || entry?.refreshToken);
  } catch (e) {
    return false;
  }
}

function normalize(store) {
  const source = store && typeof store === 'object' ? store : {};
  return {
    google: { ...blank(false), ...(source.google || {}) },
    outlook: { ...blank(false), ...(source.outlook || {}) }
  };
}

function save(store) {
  memory = normalize(store);
  const path = profileFile();
  writing = writing.then(() => IOUtils.writeJSON(path, memory, { tmpPath: path + '.tmp' })).catch(() => {});
  return writing;
}

export async function loadAccounts() {
  if (memory) return memory;
  try {
    memory = normalize(await IOUtils.readJSON(profileFile()));
  } catch (e) {
    const google = await fileHasToken('live-calendar-google-tokens.json');
    const outlook = await fileHasToken('zen-integrations-outlook-tokens.json');
    memory = normalize({
      google: blank(google),
      outlook: blank(outlook)
    });
    await save(memory);
  }
  return memory;
}

function account(id) {
  if (!memory) return blank(false);
  return memory[id] || blank(false);
}

export function isEnabled(id) {
  return !!account(id).enabled;
}

export function isExpired(id) {
  return !!account(id).enabled && !!account(id).expired;
}

export function hasToken(id) {
  return !!account(id).hasToken;
}

export function accountRecord(id) {
  return { ...account(id) };
}

async function update(id, patch) {
  const store = normalize(await loadAccounts());
  store[id] = { ...store[id], ...patch };
  await save(store);
  return store[id];
}

export function markConnected(id, contextKey) {
  return update(id, {
    enabled: true,
    expired: false,
    hasToken: true,
    contextKey: contextKey || account(id).contextKey || '',
    message: ''
  });
}

export function setAccountEmail(id, email) {
  return update(id, { email: email || '' });
}

export function setAccountMessage(id, message) {
  return update(id, { message: message || '' });
}

export function markExpired(id) {
  return update(id, { expired: true, hasToken: false, message: '' });
}

export function disconnectAccount(id) {
  return update(id, blank(false));
}
