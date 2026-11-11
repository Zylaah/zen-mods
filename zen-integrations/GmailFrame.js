(function () {
  if (typeof content === 'undefined' || content.__liveGmailWatch) return;
  let href = '';
  try {
    href = content.location.href || '';
  } catch (e) {
    return;
  }
  if (!href.includes('mail.google.com') || /\/feed\/atom/i.test(href)) return;
  content.__liveGmailWatch = true;

  let observer = null;
  let timer = null;
  let hasBaseline = false;
  const previous = new Map();

  function rowNodes() {
    const doc = content.document;
    if (!doc) return [];
    for (const selector of ['tr.zA', 'tr[role="row"]', 'div[role="row"]']) {
      const found = doc.querySelectorAll(selector);
      if (found.length) return Array.from(found);
    }
    return [];
  }

  function isUnread(row) {
    if (row.classList.contains('zE')) return true;
    if (row.getAttribute('data-is-read') === 'false') return true;
    const email = row.querySelector('span[email]');
    if (!email) return false;
    try {
      const weight = content.getComputedStyle(email).fontWeight;
      return weight === 'bold' || Number(weight) >= 600;
    } catch (e) {
      return false;
    }
  }

  function rowSubject(row) {
    const text = row.querySelector('span[data-thread-id], span.bog, .y6 span');
    return (text && text.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function rowIds(row) {
    const ids = [];
    const add = (value) => {
      if (value && ids.indexOf(value) === -1) ids.push(String(value));
    };
    add(row.getAttribute('data-legacy-thread-id'));
    add(row.getAttribute('data-thread-id'));
    add(row.getAttribute('data-thread-perm-id'));
    const marked = row.querySelector('[data-legacy-thread-id], [data-thread-id], [data-thread-perm-id]');
    if (marked) {
      add(marked.getAttribute('data-legacy-thread-id'));
      add(marked.getAttribute('data-thread-id'));
      add(marked.getAttribute('data-thread-perm-id'));
    }
    return ids;
  }

  function openConversation() {
    const doc = content.document;
    if (!doc) return { ids: [], subject: '' };
    const ids = [];
    const add = (value) => {
      if (value && ids.indexOf(value) === -1) ids.push(String(value));
    };
    const messages = Array.from(doc.querySelectorAll('[data-legacy-message-id], [data-message-id]')).filter(
      (node) => !node.closest('tr, [role="row"]')
    );
    for (const node of messages) {
      add(node.getAttribute('data-legacy-thread-id'));
      add(node.getAttribute('data-legacy-message-id'));
      add(node.getAttribute('data-thread-perm-id'));
      let parent = node.parentElement;
      for (let depth = 0; depth < 8 && parent; depth++) {
        add(parent.getAttribute('data-legacy-thread-id'));
        add(parent.getAttribute('data-thread-perm-id'));
        if (parent.getAttribute('data-legacy-thread-id') || parent.getAttribute('data-thread-perm-id')) break;
        parent = parent.parentElement;
      }
    }
    const heading = doc.querySelector('h2[data-thread-perm-id], h1[data-thread-perm-id], [role="heading"][data-thread-perm-id], h2.hP');
    if (messages.length && heading) {
      add(heading.getAttribute('data-thread-perm-id'));
      add(heading.getAttribute('data-legacy-thread-id'));
    }
    return {
      ids: ids,
      subject: messages.length && heading ? (heading.textContent || '').replace(/\s+/g, ' ').trim() : ''
    };
  }

  function publish() {
    const current = new Map();
    const subjects = new Map();
    for (const row of rowNodes()) {
      const ids = rowIds(row);
      if (!ids.length) continue;
      const unread = isUnread(row);
      const subject = rowSubject(row);
      for (const id of ids) {
        const prior = current.get(id);
        current.set(id, prior === undefined ? unread : prior || unread);
        if (subject) subjects.set(id, subject);
      }
    }

    const readIds = [];
    let subject = '';
    if (hasBaseline) {
      for (const [id, wasUnread] of previous) {
        if (!wasUnread || !current.has(id) || current.get(id)) continue;
        readIds.push(id);
        if (!subject && subjects.get(id)) subject = subjects.get(id);
      }
    }
    previous.clear();
    for (const [id, unread] of current) previous.set(id, unread);
    hasBaseline = true;

    const opened = openConversation();
    for (const id of opened.ids) {
      if (readIds.indexOf(id) === -1) readIds.push(id);
    }
    if (!subject) subject = opened.subject;
    if (!readIds.length && !subject) return;

    let page = '';
    try { page = content.location.href || ''; } catch (e) {}
    try {
      sendAsyncMessage('LiveGmail:InboxWatch', {
        href: page,
        readIds: readIds,
        subject: subject
      });
    } catch (e) {}
  }

  function schedule() {
    if (timer) content.clearTimeout(timer);
    timer = content.setTimeout(publish, 400);
  }

  function watch() {
    const doc = content.document;
    const target = (doc && (doc.documentElement || doc.body)) || null;
    if (!target) {
      content.setTimeout(watch, 500);
      return;
    }
    if (observer) observer.disconnect();
    observer = new content.MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          schedule();
          return;
        }
        const el = mutation.target;
        if (!el || !el.getAttribute) continue;
        if (el.tagName === 'TR' || el.getAttribute('role') === 'row' || (el.classList && el.classList.contains('zA'))) {
          schedule();
          return;
        }
      }
    });
    observer.observe(target, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class']
    });
    schedule();
  }

  content.addEventListener('hashchange', schedule);
  if (content.document && content.document.readyState === 'complete') watch();
  else content.addEventListener('load', watch, { once: true });
})();
