'use strict';

/**
 * 의존성 없는 cron 파서 / 다음 실행시각 계산기.
 * 표준 5필드(분 시 일 월 요일) + @daily 계열 매크로를 지원한다.
 * 모든 계산은 실행 중인 PC의 로컬 타임존 기준이다.
 */

const MACROS = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DOW_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DOW_KO = ['일', '월', '화', '수', '목', '금', '토'];

const FIELDS = [
  { key: 'minute', label: '분', min: 0, max: 59 },
  { key: 'hour', label: '시', min: 0, max: 23 },
  { key: 'dom', label: '일', min: 1, max: 31 },
  { key: 'month', label: '월', min: 1, max: 12, names: MONTH_NAMES, nameOffset: 1 },
  { key: 'dow', label: '요일', min: 0, max: 7, names: DOW_NAMES, nameOffset: 0 },
];

function toNumber(token, field) {
  const raw = String(token).trim();
  if (field.names) {
    const idx = field.names.indexOf(raw.toLowerCase().slice(0, 3));
    if (idx !== -1) return idx + field.nameOffset;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(field.label + ' 필드에 잘못된 값이 있습니다: "' + raw + '"');
  }
  const n = Number(raw);
  if (n < field.min || n > field.max) {
    throw new Error(field.label + ' 필드는 ' + field.min + '~' + field.max + ' 범위여야 합니다 (입력: ' + n + ')');
  }
  return n;
}

function parseField(raw, field) {
  const text = String(raw).trim();
  if (!text) throw new Error(field.label + ' 필드가 비어 있습니다');

  const values = new Set();
  for (const part of text.split(',')) {
    const chunk = part.trim();
    if (!chunk) throw new Error(field.label + ' 필드에 빈 항목이 있습니다');

    let rangeText = chunk;
    let step = 1;
    const slash = chunk.indexOf('/');
    if (slash !== -1) {
      rangeText = chunk.slice(0, slash).trim();
      const stepText = chunk.slice(slash + 1).trim();
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) {
        throw new Error(field.label + ' 필드의 간격(/n)이 잘못되었습니다: "' + chunk + '"');
      }
      step = Number(stepText);
    }

    let lo;
    let hi;
    if (rangeText === '*') {
      lo = field.min;
      hi = field.max;
    } else if (rangeText.includes('-')) {
      const bits = rangeText.split('-');
      lo = toNumber(bits[0], field);
      hi = toNumber(bits[1], field);
    } else {
      lo = toNumber(rangeText, field);
      // "5/15" 는 5부터 최대값까지 15간격을 뜻한다.
      hi = step === 1 ? lo : field.max;
    }

    if (lo > hi) {
      // "금-월" 처럼 되감기는 범위를 지원한다.
      for (let v = lo; v <= field.max; v += step) values.add(v);
      for (let v = field.min; v <= hi; v += step) values.add(v);
    } else {
      for (let v = lo; v <= hi; v += step) values.add(v);
    }
  }

  // 요일 7(일요일)을 0으로 정규화한다.
  if (field.key === 'dow' && values.has(7)) {
    values.delete(7);
    values.add(0);
  }
  return values;
}

/** cron 문자열을 파싱한다. 잘못된 표현식이면 Error를 던진다. */
function parse(expression) {
  if (typeof expression !== 'string' || !expression.trim()) {
    throw new Error('스케줄 표현식이 비어 있습니다');
  }
  let text = expression.trim().toLowerCase();
  if (text.startsWith('@')) {
    const macro = MACROS[text];
    if (!macro) throw new Error('지원하지 않는 매크로입니다: ' + text);
    text = macro;
  }

  const parts = text.split(/\s+/);
  if (parts.length === 6) {
    throw new Error('초 단위 6필드 cron은 지원하지 않습니다. 분 단위 5필드로 입력하세요');
  }
  if (parts.length !== 5) {
    throw new Error('cron은 5개 필드여야 합니다 (분 시 일 월 요일) — 입력된 필드 수: ' + parts.length);
  }

  const parsed = { source: expression.trim(), raw: {} };
  FIELDS.forEach(function (field, i) {
    parsed[field.key] = parseField(parts[i], field);
    parsed.raw[field.key] = parts[i];
  });
  parsed.domWildcard = parts[2] === '*';
  parsed.dowWildcard = parts[4] === '*';
  return parsed;
}

/** 표현식이 유효한지 확인한다. { ok, error } 를 돌려준다. */
function validate(expression) {
  try {
    parse(expression);
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function matchesDay(c, date) {
  const domHit = c.dom.has(date.getDate());
  const dowHit = c.dow.has(date.getDay());
  // 표준 cron 규칙: 일/요일이 둘 다 지정되면 OR, 한쪽이 *면 나머지만 본다.
  if (c.domWildcard && c.dowWildcard) return true;
  if (c.domWildcard) return dowHit;
  if (c.dowWildcard) return domHit;
  return domHit || dowHit;
}

/** from 이후(from 자신은 제외)의 첫 실행 시각을 돌려준다. 없으면 null. */
function nextAfter(expression, from) {
  const c = typeof expression === 'string' ? parse(expression) : expression;
  const base = from || new Date();
  const t = new Date(base.getTime());
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);

  const limit = new Date(t.getTime());
  limit.setFullYear(limit.getFullYear() + 5);

  while (t.getTime() <= limit.getTime()) {
    if (!c.month.has(t.getMonth() + 1)) {
      t.setMonth(t.getMonth() + 1, 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    if (!matchesDay(c, t)) {
      t.setDate(t.getDate() + 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    if (!c.hour.has(t.getHours())) {
      t.setHours(t.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!c.minute.has(t.getMinutes())) {
      t.setMinutes(t.getMinutes() + 1, 0, 0);
      continue;
    }
    return t;
  }
  return null;
}

/** 다음 n회 실행 시각을 배열로 돌려준다 (UI 미리보기용). */
function nextRuns(expression, count, from) {
  const c = parse(expression);
  const total = count || 5;
  const out = [];
  let cursor = from || new Date();
  for (let i = 0; i < total; i += 1) {
    const next = nextAfter(c, cursor);
    if (!next) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function listOf(set) {
  return [...set].sort(function (a, b) { return a - b; });
}

/** cron 표현식을 한국어 한 줄 설명으로 바꾼다. 해석이 어려우면 원문을 돌려준다. */
function describe(expression) {
  let c;
  try {
    c = parse(expression);
  } catch (err) {
    return expression;
  }
  const r = c.raw;
  const isEvery = function (v) { return v === '*'; };
  const stepOf = function (v) {
    const m = /^\*\/(\d+)$/.exec(v);
    return m ? Number(m[1]) : null;
  };

  const minuteStep = stepOf(r.minute);
  const hourStep = stepOf(r.hour);
  const dateFree = isEvery(r.dom) && isEvery(r.month) && isEvery(r.dow);

  if (minuteStep && isEvery(r.hour) && dateFree) {
    return minuteStep + '분마다';
  }
  if (/^\d+$/.test(r.minute) && isEvery(r.hour) && dateFree) {
    return '매시 ' + Number(r.minute) + '분';
  }
  if (/^\d+$/.test(r.minute) && hourStep && dateFree) {
    return hourStep + '시간마다 (' + pad(Number(r.minute)) + '분)';
  }

  const mins = listOf(c.minute);
  const hours = listOf(c.hour);
  let timePart = null;
  if (mins.length === 1 && hours.length === 1) {
    timePart = pad(hours[0]) + ':' + pad(mins[0]);
  } else if (mins.length === 1 && hours.length <= 4) {
    timePart = hours.map(function (h) { return pad(h) + ':' + pad(mins[0]); }).join(', ');
  }
  if (!timePart) return expression;

  let dowText = null;
  if (!c.dowWildcard) {
    const days = listOf(c.dow);
    if (days.length === 5 && days.join() === '1,2,3,4,5') dowText = '평일(월~금)';
    else if (days.length === 2 && days.join() === '0,6') dowText = '주말';
    else dowText = '매주 ' + days.map(function (d) { return DOW_KO[d]; }).join('·') + '요일';
  }
  const monthText = isEvery(r.month) ? null : listOf(c.month).join('·') + '월';
  // 월이 함께 지정되면 "2월 매월 29일" 처럼 겹치므로 "매월"을 뺀다.
  const domText = c.domWildcard ? null : (monthText ? '' : '매월 ') + listOf(c.dom).join('·') + '일';

  const when = [monthText, domText, dowText].filter(Boolean).join(' ');
  if (!when) return '매일 ' + timePart;
  return when + ' ' + timePart;
}

const PRESETS = [
  { label: '5분마다', value: '*/5 * * * *' },
  { label: '15분마다', value: '*/15 * * * *' },
  { label: '30분마다', value: '*/30 * * * *' },
  { label: '매시 정각', value: '0 * * * *' },
  { label: '매일 오전 9시', value: '0 9 * * *' },
  { label: '매일 오후 6시', value: '0 18 * * *' },
  { label: '매일 자정', value: '0 0 * * *' },
  { label: '평일 오전 8시 30분', value: '30 8 * * 1-5' },
  { label: '평일 오전 9시', value: '0 9 * * 1-5' },
  { label: '평일 오후 6시', value: '0 18 * * 1-5' },
  { label: '매주 월요일 오전 9시', value: '0 9 * * 1' },
  { label: '매주 금요일 오후 5시', value: '0 17 * * 5' },
  { label: '매월 1일 오전 9시', value: '0 9 1 * *' },
];

module.exports = { parse, validate, nextAfter, nextRuns, describe, PRESETS };
