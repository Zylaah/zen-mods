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

const { parseDateLabel, isoLocal, takeDate } = ChromeUtils.importESModule(
  'chrome://sine/content/zen-integrations/providers/OutlookDate.sys.mjs' + new URL(import.meta.url).search
);


function dateFromTitles(row, now) {
  for (const el of row.querySelectorAll('[title]')) {
    const text = String(el.innerText || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 32 || !parseDateLabel(text, now)) continue;
    const ts = Date.parse(el.getAttribute('title') || '');
    return { text, date: Number.isFinite(ts) ? new Date(ts) : parseDateLabel(text, now) };
  }
  return null;
}

function fieldsFromLines(lines, now, titled) {
  const copy = lines.slice();
  let date = titled?.date || null;
  if (titled?.text) {
    const exact = copy.findIndex((line) => line === titled.text);
    if (exact !== -1) copy.splice(exact, 1);
    else {
      for (let i = 0; i < copy.length; i++) {
        if (copy[i].endsWith(titled.text) && copy[i].length > titled.text.length) {
          copy[i] = copy[i].slice(0, -titled.text.length).trim();
          break;
        }
      }
    }
  }
  if (!date) {
    for (let i = 0; i < copy.length; i++) {
      const taken = takeDate(copy[i], now);
      if (!taken.date) continue;
      date = taken.date;
      if (taken.rest) copy[i] = taken.rest;
      else copy.splice(i, 1);
      break;
    }
  }
  if (!date && copy.length) {
    const match = copy[0].match(/^(.*\S)\s+(\d{1,2}\s*[:h.]\s*\d{2}(?:\s*[ap]\.?m\.?)?)$/i);
    if (match && parseDateLabel(match[2], now)) {
      copy[0] = match[1].trim();
      date = parseDateLabel(match[2], now);
    }
  }
  return {
    from: copy[0] || 'Unknown',
    subject: copy[1] || '(No subject)',
    snippet: copy.slice(2).join(' ').replace(/\s+/g, ' ').trim().slice(0, 200),
    date: date ? isoLocal(date) : ''
  };
}

function fieldsFromLeafList(leaves, now) {
  const items = (leaves || []).filter((leaf) => leaf.text && leaf.text.length > 1 && !/^[-–—|•·]+$/.test(leaf.text));
  if (items.length < 2) return null;
  items.sort((a, b) => a.top - b.top);
  const dateLeaf = items.find((leaf) => parseDateLabel(leaf.text, now));
  const parsedTitle = dateLeaf ? Date.parse(dateLeaf.title) : NaN;
  const date = dateLeaf
    ? (Number.isFinite(parsedTitle) ? new Date(parsedTitle) : parseDateLabel(dateLeaf.text, now))
    : null;
  const body = items.filter((leaf) => leaf !== dateLeaf);
  const groups = [];
  for (const leaf of body) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(last.top - leaf.top) <= 4) last.items.push(leaf);
    else groups.push({ top: leaf.top, items: [leaf] });
  }
  if (!groups.length) return null;
  const subjectItems = groups[1]?.items || [];
  let subjectLeaf = subjectItems.find((leaf) => leaf.title && !parseDateLabel(leaf.text, now));
  if (!subjectLeaf && subjectItems.length) {
    const maxWeight = Math.max(...subjectItems.map((leaf) => leaf.weight || 0));
    subjectLeaf = subjectItems.find((leaf) => (leaf.weight || 0) === maxWeight);
  }
  const snippetParts = [];
  if (subjectLeaf) {
    for (const leaf of subjectItems) {
      if (leaf !== subjectLeaf) snippetParts.push(leaf.text);
    }
  }
  for (const group of groups.slice(2)) {
    for (const leaf of group.items) snippetParts.push(leaf.text);
  }
  return {
    from: groups[0].items.map((leaf) => leaf.text).join(' ').trim() || 'Unknown',
    subject: subjectLeaf?.text || '(No subject)',
    snippet: snippetParts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 200),
    date: date ? isoLocal(date) : ''
  };
}

function rowLeaves(row) {
  const view = row.ownerDocument.defaultView;
  const leaves = [];
  for (const el of row.querySelectorAll('span, time, div')) {
    if (el.closest('button, [role="button"]')) continue;
    if (el.querySelector('span, time, div')) continue;
    const text = String(el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 500) continue;
    let style;
    try { style = view.getComputedStyle(el); } catch (e) { continue; }
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    leaves.push({
      text,
      title: String(el.getAttribute('title') || '').trim(),
      weight: parseInt(style.fontWeight, 10) || 400,
      top: rect.top
    });
  }
  return leaves;
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
    const now = new Date();
    const fromLines = fieldsFromLines(lines, now, dateFromTitles(row, now));
    const fromLeaves = fieldsFromLeafList(rowLeaves(row), now);
    const fields = fromLeaves?.snippet || fromLeaves?.date
      ? {
          from: fromLeaves.from || fromLines.from,
          subject: fromLeaves.subject && fromLeaves.subject !== '(No subject)' ? fromLeaves.subject : fromLines.subject,
          snippet: fromLeaves.snippet || fromLines.snippet,
          date: fromLeaves.date || fromLines.date
        }
      : fromLines;
    rows.push({
      id,
      key,
      from: fields.from,
      subject: fields.subject,
      snippet: fields.snippet,
      date: fields.date
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
