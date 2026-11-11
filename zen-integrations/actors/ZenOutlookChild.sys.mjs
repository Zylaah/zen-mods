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

const WEEKDAY = {
  sun: 0, sunday: 0, dim: 0, dimanche: 0,
  mon: 1, monday: 1, lun: 1, lundi: 1,
  tue: 2, tues: 2, tuesday: 2, mar: 2, mardi: 2,
  wed: 3, wednesday: 3, mer: 3, mercredi: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, jeu: 4, jeudi: 4,
  fri: 5, friday: 5, ven: 5, vendredi: 5,
  sat: 6, saturday: 6, sam: 6, samedi: 6
};

const MONTH = {
  jan: 0, january: 0, janv: 0, janvier: 0,
  feb: 1, february: 1, fev: 1, fevr: 1, fevrier: 1,
  march: 2, mars: 2,
  apr: 3, april: 3, avr: 3, avril: 3,
  may: 4, mai: 4,
  jun: 5, june: 5, juin: 5,
  jul: 6, july: 6, juil: 6, juillet: 6,
  aug: 7, august: 7, aou: 7, aout: 7,
  sep: 8, sept: 8, september: 8, septembre: 8,
  oct: 9, october: 9, octobre: 9,
  nov: 10, november: 10, novembre: 10,
  dec: 11, december: 11, decembre: 11
};

const RELATIVE_TODAY = new Set(['today', 'aujourd', 'aujourdhui', 'hoy', 'heute', 'oggi', 'vandaag', 'idag']);
const RELATIVE_YESTERDAY = new Set(['yesterday', 'hier', 'ayer', 'gestern', 'ieri', 'gisteren', 'igar']);

function normToken(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’.]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function atNoon(year, month, day) {
  const date = new Date(year, month, day, 12, 0, 0);
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null;
  return date;
}

function thisYear(month, day, now) {
  let date = atNoon(now.getFullYear(), month, day);
  if (!date) return null;
  if (date.getTime() > now.getTime() + 36 * 60 * 60 * 1000) date = atNoon(now.getFullYear() - 1, month, day);
  return date;
}

function monthIndex(token) {
  const key = normToken(token);
  if (key === 'mar') return 2;
  return Object.prototype.hasOwnProperty.call(MONTH, key) ? MONTH[key] : null;
}

function parseNumericDate(match, now) {
  const a = Number(match[1]);
  const b = Number(match[2]);
  const c = match[3] ? Number(match[3]) : null;
  let year = null;
  let month = null;
  let day = null;
  if (c == null) {
    if (a > 12) {
      day = a;
      month = b - 1;
    } else if (b > 12) {
      month = a - 1;
      day = b;
    } else {
      day = a;
      month = b - 1;
    }
    return thisYear(month, day, now);
  }
  if (a > 31) {
    year = a;
    month = b - 1;
    day = c;
  } else {
    year = c < 100 ? 2000 + c : c;
    if (a > 12) {
      day = a;
      month = b - 1;
    } else if (b > 12) {
      month = a - 1;
      day = b;
    } else {
      day = a;
      month = b - 1;
    }
  }
  return atNoon(year, month, day);
}

function parseDateLabel(line, now) {
  const raw = String(line || '').trim();
  if (!raw || raw.length > 32) return null;
  const hadTime = /\d{1,2}\s*[:h.]\s*\d{2}/i.test(raw);
  const rest = raw
    .replace(/\d{1,2}\s*[:h.]\s*\d{2}(?:\s*[ap]\.?m\.?)?/gi, ' ')
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!rest) return hadTime ? atNoon(now.getFullYear(), now.getMonth(), now.getDate()) : null;
  const key = normToken(rest);
  if (RELATIVE_TODAY.has(key)) return atNoon(now.getFullYear(), now.getMonth(), now.getDate());
  if (RELATIVE_YESTERDAY.has(key)) return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12, 0, 0);
  if (Object.prototype.hasOwnProperty.call(WEEKDAY, key)) {
    const delta = (now.getDay() - WEEKDAY[key] + 7) % 7;
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - delta, 12, 0, 0);
  }
  const numeric = rest.match(/^(\d{1,4})[/\-.](\d{1,2})(?:[/\-.](\d{2,4}))?$/);
  if (numeric) return parseNumericDate(numeric, now);
  const parts = rest.split(' ');
  if (parts.length === 2 || parts.length === 3) {
    const nums = parts.filter((part) => /^\d{1,4}$/.test(part));
    const words = parts.filter((part) => !/^\d{1,4}$/.test(part));
    if (nums.length >= 1 && words.length === 1 && monthIndex(words[0]) != null) {
      const month = monthIndex(words[0]);
      const day = Number(nums[0]);
      if (nums[1]) {
        const year = Number(nums[1]) < 100 ? 2000 + Number(nums[1]) : Number(nums[1]);
        return atNoon(year, month, day);
      }
      return thisYear(month, day, now);
    }
  }
  return null;
}

function isoLocal(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    'T' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':00'
  );
}

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
      const parsed = parseDateLabel(copy[i], now);
      if (!parsed) continue;
      date = parsed;
      copy.splice(i, 1);
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
    const fields = fieldsFromLines(lines, now, dateFromTitles(row, now));
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
