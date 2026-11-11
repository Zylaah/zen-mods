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
  const lead = rest.match(/^(\p{L}+)\.?\s+(\d{1,2}[/\-.]\d{1,2}(?:[/\-.]\d{2,4})?|\d{1,2}\s+\p{L}+\.?)$/u);
  if (lead && Object.prototype.hasOwnProperty.call(WEEKDAY, normToken(lead[1]))) {
    return parseDateLabel(lead[2], now);
  }
  return null;
}

function takeDate(text, now) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return { date: null, rest: '' };
  const whole = parseDateLabel(raw, now);
  if (whole) return { date: whole, rest: '' };
  const parts = raw.split(' ');
  for (let n = Math.min(3, parts.length - 1); n >= 1; n--) {
    const tail = parts.slice(-n).join(' ');
    if (n === 1 && !/\d/.test(tail)) continue;
    const parsed = parseDateLabel(tail, now);
    if (!parsed) continue;
    return { date: parsed, rest: parts.slice(0, -n).join(' ') };
  }
  return { date: null, rest: raw };
}

function isoLocal(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
    'T' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':00'
  );
}

export function normalizeOutlookFields(row, now = new Date()) {
  let snippet = String(row?.snippet || '').replace(/\s+/g, ' ').trim();
  const dateText = String(row?.date || '').trim();
  let parsed = null;
  if (/^\d{4}-\d{2}-\d{2}T/.test(dateText)) {
    const existing = new Date(dateText);
    if (!Number.isNaN(existing.getTime())) parsed = existing;
  } else if (dateText) {
    const taken = takeDate(dateText, now);
    if (taken.date) {
      parsed = taken.date;
      if (taken.rest) snippet = [taken.rest, snippet].filter(Boolean).join(' ');
    }
  }
  if (!parsed && snippet) {
    const taken = takeDate(snippet, now);
    if (taken.date) {
      parsed = taken.date;
      snippet = taken.rest;
    }
  }
  return {
    snippet: snippet.slice(0, 200),
    date: parsed ? isoLocal(parsed) : (/^\d{4}-\d{2}-\d{2}T/.test(dateText) ? dateText : '')
  };
}

export { parseDateLabel, isoLocal, takeDate };
