const UNREAD_WORD = /^(unread|non lu|no le[ií]do|ungelesen|n[aã]o lid[ao]|ongelezen|non letto|ol[aä]st|ul[aæ]st|непрочитан)/i;

function linesOf(row) {
  return String(row?.innerText || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function contentLines(row) {
  const lines = linesOf(row);
  const body = lines.filter((line) => line.length > 1);
  return body.length ? body : lines;
}

function isUnread(row) {
  const label = row.getAttribute('aria-label') || '';
  if (UNREAD_WORD.test(label)) return true;
  const icon = row.querySelector('[data-icon-name]');
  const iconName = icon?.getAttribute('data-icon-name') || '';
  if (/unread|circlefill|circlesmallfilled|statuscircle/i.test(iconName)) return true;
  const first = row.querySelector('span');
  if (!first) return false;
  const weight = parseInt(row.ownerDocument.defaultView.getComputedStyle(first).fontWeight, 10);
  return weight >= 600;
}

function messageList(doc) {
  const boxes = doc.querySelectorAll('[role="listbox"], [role="list"]');
  for (const box of boxes) {
    if (box.querySelector('[role="option"], [role="listitem"], [role="row"]')) return box;
  }
  return null;
}

function scrapeDocument(doc) {
  const list = messageList(doc);
  if (!list) return { ready: false, rows: [] };
  const rows = [];
  const seen = new Set();
  for (const row of list.querySelectorAll('[role="option"], [role="listitem"], [role="row"]')) {
    if (!isUnread(row)) continue;
    const lines = contentLines(row);
    if (!lines.length) continue;
    const id = row.getAttribute('data-convid') || row.getAttribute('data-id') || row.id || '';
    const key = id || lines.slice(0, 2).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    const date = lines.length > 2 ? lines[lines.length - 1] : '';
    rows.push({
      id,
      key,
      from: lines[0] || 'Unknown',
      subject: lines[1] || lines[0] || '(No subject)',
      snippet: lines.length > 3 ? lines.slice(2, -1).join(' ').slice(0, 200) : '',
      date: date.length < 40 ? date : ''
    });
    if (rows.length >= 20) break;
  }
  return { ready: true, rows };
}

function findRow(doc, data) {
  const list = messageList(doc);
  if (!list) return null;
  const id = String(data?.id || '');
  if (id) {
    const byId = list.querySelector(`[data-convid="${CSS.escape(id)}"], [data-id="${CSS.escape(id)}"]`);
    if (byId) return byId;
  }
  const subject = String(data?.subject || '').trim();
  if (!subject) return null;
  for (const row of list.querySelectorAll('[role="option"], [role="listitem"], [role="row"]')) {
    if (linesOf(row).includes(subject)) return row;
  }
  return null;
}

export class ZenOutlookChild extends JSWindowActorChild {
  receiveMessage(message) {
    if (this.contentWindow !== this.contentWindow?.top) return null;
    if (message.name === 'ZenOutlook:Scrape') return scrapeDocument(this.document);
    if (message.name === 'ZenOutlook:Open') {
      const row = findRow(this.document, message.data);
      if (!row) return { ok: false };
      row.click();
      return { ok: true };
    }
    return null;
  }
}
