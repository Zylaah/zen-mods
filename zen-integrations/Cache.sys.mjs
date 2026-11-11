const { CONFIG, debugLog, profilePath, scopedCacheKey } = ChromeUtils.importESModule(
  'chrome://sine/content/zen-integrations/Util.sys.mjs' + new URL(import.meta.url).search
);

export class ZenCache {
  constructor(app) {
    this.app = app;
  }

  normalizeEntry(entry) {
    if (Array.isArray(entry)) return { emails: entry, lastScanTs: 0 };
    if (entry && Array.isArray(entry.emails)) {
      return {
        emails: entry.emails,
        lastScanTs: typeof entry.lastScanTs === 'number' ? entry.lastScanTs : 0
      };
    }
    return { emails: [], lastScanTs: 0 };
  }

  migrateStore(store) {
    const migrated = {};
    for (const [key, entry] of Object.entries(store || {})) {
      const storeKey = scopedCacheKey(key);
      const normalized = this.normalizeEntry(entry);
      const existing = migrated[storeKey];
      if (!existing) {
        migrated[storeKey] = normalized;
        continue;
      }
      const preferNew =
        normalized.lastScanTs > existing.lastScanTs ||
        (normalized.lastScanTs === existing.lastScanTs &&
          normalized.emails.length > existing.emails.length);
      if (preferNew) migrated[storeKey] = normalized;
    }
    return migrated;
  }

  hydrateContext(key, ctx) {
    const store = this.app.diskCacheStore;
    if (!ctx || !Object.prototype.hasOwnProperty.call(store, key)) return;
    const entry = this.normalizeEntry(store[key]);
    ctx.hasScanned = true;
    if (!ctx.lastScanTs && entry.lastScanTs) ctx.lastScanTs = entry.lastScanTs;
    if (ctx.cachedEmails.length === 0 && entry.emails.length > 0) {
      ctx.cachedEmails = entry.emails.slice();
    }
  }

  getOrCreateContext(key) {
    const storeKey = scopedCacheKey(key ?? 'gmail:0');
    const contexts = this.app.panelContexts;
    if (!contexts.has(storeKey)) {
      const store = this.app.diskCacheStore;
      const entry = Object.prototype.hasOwnProperty.call(store, storeKey)
        ? this.normalizeEntry(store[storeKey])
        : { emails: [], lastScanTs: 0 };
      contexts.set(storeKey, {
        currentEmails: [],
        cachedEmails: entry.emails.slice(),
        clickedEmailIds: new Set(),
        hasScanned: Object.prototype.hasOwnProperty.call(store, storeKey),
        lastScanTs: entry.lastScanTs
      });
    } else {
      this.hydrateContext(storeKey, contexts.get(storeKey));
    }
    return contexts.get(storeKey);
  }

  persistActive(key = this.app.activePanelContextKey) {
    if (!key) return;
    const ctx = this.getOrCreateContext(key);
    ctx.currentEmails = this.app.currentEmails;
    ctx.cachedEmails = this.app.cachedEmails;
  }

  activate(key) {
    if (key == null || key === '') return;
    const storeKey = scopedCacheKey(key);
    if (storeKey !== this.app.activePanelContextKey) {
      this.persistActive(this.app.activePanelContextKey);
      this.app.activePanelContextKey = storeKey;
      debugLog('Panel context:', storeKey);
    }
    const ctx = this.getOrCreateContext(storeKey);
    this.app.currentEmails = ctx.currentEmails;
    this.app.cachedEmails = ctx.cachedEmails;
    this.app.clickedEmailIds = ctx.clickedEmailIds;
  }

  save() {
    try {
      this.persistActive(this.app.activePanelContextKey);
      for (const [key, ctx] of this.app.panelContexts.entries()) {
        this.app.diskCacheStore[key] = {
          emails: ctx.cachedEmails.slice(0, CONFIG.MAX_EMAILS).map((email) => ({
            id: email.id,
            threadId: email.threadId || email.id,
            gmailThreadId: email.gmailThreadId || '',
            legacyThreadId: email.legacyThreadId || '',
            url: email.url || '',
            from: email.from,
            subject: email.subject,
            snippet: email.snippet || '',
            date: email.date,
            isUnread: email.isUnread
          })),
          lastScanTs: ctx.lastScanTs || 0
        };
      }
      this.app.diskCacheStore = this.migrateStore(this.app.diskCacheStore);
      IOUtils.writeUTF8(profilePath(CONFIG.CACHE_FILE), JSON.stringify(this.app.diskCacheStore)).catch(() => {});
    } catch (e) {}
  }

  applyStore(parsed) {
    if (Array.isArray(parsed)) {
      this.app.diskCacheStore = this.migrateStore({ '0': parsed });
    } else if (parsed && typeof parsed === 'object') {
      this.app.diskCacheStore = this.migrateStore(parsed);
    }
    for (const storeKey of Object.keys(this.app.diskCacheStore)) {
      this.getOrCreateContext(storeKey);
    }
  }

  load() {
    const finish = () => {
      const activeKey = this.app.activePanelContextKey;
      if (activeKey) this.activate(activeKey);
      this.app.panel.updateDisplay();
    };
    const read = (path, legacy) => IOUtils.readUTF8(path).then((json) => {
      this.applyStore(JSON.parse(json));
      if (legacy) debugLog('Migrated cache from', CONFIG.LEGACY_CACHE_FILE);
      const activeKey = this.app.activePanelContextKey;
      debugLog(
        'Restored',
        activeKey ? this.getOrCreateContext(activeKey).cachedEmails.length : 0,
        'messages for',
        activeKey || '(no panel yet)'
      );
      finish();
    });
    try {
      read(profilePath(CONFIG.CACHE_FILE), false).catch(() => {
        read(profilePath(CONFIG.LEGACY_CACHE_FILE), true).catch(() => {});
      });
    } catch (e) {}
  }
}
