const { CONFIG, debugLog, getContextContainerId } = ChromeUtils.importESModule(
  'chrome://sine/content/live-gmail/LiveGmailUtil.sys.mjs' + new URL(import.meta.url).search
);

export class LiveGmailCache {
  constructor(app) {
    this.app = app;
  }

  getFilePath() {
    const profileDir = Services.dirsvc.get('ProfD', Ci.nsIFile).path;
    return PathUtils.join(profileDir, 'live-gmail-cache.json');
  }

  normalizeEntry(entry) {
    if (Array.isArray(entry)) {
      return { emails: entry, lastScanTs: 0 };
    }
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
      const containerKey = String(getContextContainerId(key));
      const normalized = this.normalizeEntry(entry);
      const existing = migrated[containerKey];
      if (!existing) {
        migrated[containerKey] = normalized;
        continue;
      }
      const preferNew =
        normalized.lastScanTs > existing.lastScanTs ||
        (normalized.lastScanTs === existing.lastScanTs &&
          normalized.emails.length > existing.emails.length);
      if (preferNew) {
        migrated[containerKey] = normalized;
      }
    }
    return migrated;
  }

  hydrateContext(key, ctx) {
    const store = this.app.diskCacheStore;
    if (!ctx || !Object.prototype.hasOwnProperty.call(store, key)) return;
    const entry = this.normalizeEntry(store[key]);
    ctx.hasScanned = true;
    if (!ctx.lastScanTs && entry.lastScanTs) {
      ctx.lastScanTs = entry.lastScanTs;
    }
    if (ctx.cachedEmails.length === 0 && entry.emails.length > 0) {
      ctx.cachedEmails = entry.emails.slice();
    }
  }

  getOrCreateContext(key) {
    const storeKey = String(key ?? 0);
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
    const storeKey = String(key);
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
      IOUtils.writeUTF8(this.getFilePath(), JSON.stringify(this.app.diskCacheStore)).catch(() => {});
    } catch (e) {}
  }

  load() {
    const fallback = () => this.activate(this.app.getPanelContextKey());
    try {
      IOUtils.readUTF8(this.getFilePath())
        .then((json) => {
          const parsed = JSON.parse(json);
          if (Array.isArray(parsed)) {
            this.app.diskCacheStore = this.migrateStore({ '0': parsed });
          } else if (parsed && typeof parsed === 'object') {
            this.app.diskCacheStore = this.migrateStore(parsed);
          }
          for (const storeKey of Object.keys(this.app.diskCacheStore)) {
            this.getOrCreateContext(storeKey);
          }
          const activeKey = this.app.getPanelContextKey();
          this.activate(activeKey);
          debugLog(
            'Restored',
            this.getOrCreateContext(activeKey).cachedEmails.length,
            'emails for context',
            activeKey
          );
          this.app.panel.updateDisplay();
        })
        .catch(fallback);
    } catch (e) {
      fallback();
    }
  }
}
