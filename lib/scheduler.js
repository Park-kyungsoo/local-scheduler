'use strict';

/**
 * 스케줄 루프.
 * 분 경계에 맞춰 깨어나 각 작업의 다음 실행 시각을 확인하고 도달한 작업을 실행한다.
 * 다음 실행 시각은 state.json 에 저장하므로, PC를 껐다 켜도 놓친 일정을 판단할 수 있다.
 */

const cron = require('./cron');
const store = require('./store');
const runner = require('./runner');

/** 실제 실행 시각이 예정보다 이만큼 이상 늦으면 "놓친 일정"으로 본다. */
const LATE_THRESHOLD_MS = 90 * 1000;

let timer = null;
let started = false;
let state = {};

function log(message) {
  console.log('[' + new Date().toLocaleString('ko-KR') + '] ' + message);
}

function computeNext(job, from) {
  try {
    const next = cron.nextAfter(job.schedule, from || new Date());
    return next ? next.getTime() : null;
  } catch (err) {
    log('스케줄 해석 실패 — "' + job.name + '": ' + err.message);
    return null;
  }
}

/** 특정 작업의 다음 실행 시각을 다시 계산해 저장한다. */
function reschedule(jobId, from) {
  const job = store.getJob(jobId);
  if (!job || !job.enabled) {
    delete state[jobId];
    store.saveState(state);
    return null;
  }
  const next = computeNext(job, from);
  state[jobId] = Object.assign({}, state[jobId], { nextRunAt: next });
  store.saveState(state);
  return next;
}

/** 저장된 상태를 현재 작업 목록에 맞춰 정리한다. */
function syncState() {
  const jobs = store.loadJobs();
  const now = new Date();
  const alive = new Set();

  for (const job of jobs) {
    alive.add(job.id);
    if (!job.enabled) {
      delete state[job.id];
      continue;
    }
    const entry = state[job.id];
    // 스케줄이 바뀌었거나 상태가 없으면 새로 계산한다.
    if (!entry || entry.schedule !== job.schedule || entry.nextRunAt == null) {
      state[job.id] = { schedule: job.schedule, nextRunAt: computeNext(job, now) };
    }
  }
  // 삭제된 작업의 상태를 버린다.
  for (const id of Object.keys(state)) {
    if (!alive.has(id)) delete state[id];
  }
  store.saveState(state);
}

function fire(job, scheduledFor, trigger) {
  const result = runner.run(job, {
    trigger: trigger,
    scheduledFor: scheduledFor ? new Date(scheduledFor).toISOString() : null,
  });
  if (result.skipped) {
    log('건너뜀 — "' + job.name + '": ' + result.reason);
  } else {
    log('실행 — "' + job.name + '"' + (trigger === 'catchup' ? ' (놓친 일정 보정)' : ''));
  }
  return result;
}

function tick() {
  const now = Date.now();
  const jobs = store.loadJobs();

  for (const job of jobs) {
    // 한 작업에서 터진 예외가 같은 분의 나머지 작업까지 막지 않도록 작업별로 격리한다.
    try {
      tickJob(job, now);
    } catch (err) {
      log('작업 처리 중 오류 — "' + job.name + '": ' + (err && err.message ? err.message : err));
    }
  }

  store.saveState(state);
}

function tickJob(job, now) {
  if (!job.enabled) {
    delete state[job.id];
    return;
  }

  let entry = state[job.id];
  if (!entry || entry.schedule !== job.schedule || entry.nextRunAt == null) {
    state[job.id] = { schedule: job.schedule, nextRunAt: computeNext(job, new Date(now)) };
    return;
  }

  if (entry.nextRunAt > now) return;

  // 여러 번 밀린 경우 마지막으로 놓친 시각만 남기고 건너뛴다.
  let scheduledFor = entry.nextRunAt;
  let next = entry.nextRunAt;
  let missed = 0;
  while (next != null && next <= now) {
    scheduledFor = next;
    next = computeNext(job, new Date(next));
    missed += 1;
    if (missed > 10000) break; // 방어: 비정상 표현식으로 인한 무한 루프 차단
  }
  entry.nextRunAt = next;
  entry.schedule = job.schedule;

  const lateBy = now - scheduledFor;
  const isLate = lateBy > LATE_THRESHOLD_MS;

  if (isLate && !job.catchUp) {
    log('지난 일정 건너뜀 — "' + job.name + '" (' + new Date(scheduledFor).toLocaleString('ko-KR')
      + ' 예정, ' + runner.formatDuration(lateBy) + ' 경과)');
  } else {
    fire(job, scheduledFor, isLate ? 'catchup' : 'schedule');
  }
}

/** 다음 분 경계(+1초)에 맞춰 다음 틱을 예약한다. */
function scheduleNextTick() {
  const now = new Date();
  const delay = (60 - now.getSeconds()) * 1000 - now.getMilliseconds() + 1000;
  timer = setTimeout(function () {
    try {
      tick();
    } catch (err) {
      console.error('[scheduler] 틱 처리 중 오류:', err);
    }
    scheduleNextTick();
  }, Math.max(delay, 1000));
  if (timer.unref) timer.unref();
}

function start() {
  if (started) return;
  started = true;
  store.ensureDirs();
  store.migrateLegacyLastRun();
  store.reconcileOrphanRuns();
  state = store.loadState();
  syncState();

  const jobs = store.loadJobs();
  const enabled = jobs.filter(function (j) { return j.enabled; }).length;
  log('스케줄러 시작 — 작업 ' + jobs.length + '개 (활성 ' + enabled + '개)');
  for (const job of jobs) {
    if (!job.enabled) continue;
    const next = state[job.id] && state[job.id].nextRunAt;
    log('  · ' + job.name + ' — ' + cron.describe(job.schedule)
      + (next ? ' → 다음 ' + new Date(next).toLocaleString('ko-KR') : ''));
  }

  tick(); // 재시작 직후 놓친 일정을 즉시 판단한다
  scheduleNextTick();
}

function stop() {
  if (timer) clearTimeout(timer);
  timer = null;
  started = false;
}

/** 작업이 추가·수정·삭제되었을 때 서버가 호출한다. */
function refresh() {
  state = store.loadState();
  syncState();
}

function nextRunAt(jobId) {
  const entry = state[jobId];
  return entry && entry.nextRunAt ? entry.nextRunAt : null;
}

module.exports = { start, stop, refresh, reschedule, nextRunAt, tick };
