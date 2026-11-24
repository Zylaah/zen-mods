export function base64Url(bytes) {
  const list = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  let binary = '';
  for (const value of list) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function cryptoApi(win) {
  return win?.crypto || globalThis.crypto || null;
}

export function randomToken(win) {
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

export async function codeChallenge(win, verifier) {
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
