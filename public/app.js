'use strict';

const $ = function (sel) { return document.querySelector(sel); };
const state = { jobs: [], presets: [], permissionModes: [], editingId: null, type: 'claude', logJobId: null, logRunId: null };

// ------------------------------------------------------------------ 공통

async function api(path, options) {
  const res = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, options));
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error || ('요청 실패 (' + res.status + ')'));
  return data;
}

function toast(message, kind) {
  const el = document.createElement('div');
  el.className = 'toast ' + (kind || 'ok');
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(function () { el.remove(); }, 4200);
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtRelative(ms) {
  if (ms == null) return '—';
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const min = Math.round(abs / 60000);
  if (min < 1) return diff >= 0 ? '곧' : '방금';
  const suffix = diff >= 0 ? ' 후' : ' 전';
  if (min < 60) return min + '분' + suffix;
  const hour = Math.floor(min / 60);
  if (hour < 24) return hour + '시간 ' + (min % 60) + '분' + suffix;
  return Math.floor(hour / 24) + '일 ' + (hour % 24) + '시간' + suffix;
}

function fmtDuration(ms) {
  if (ms == null) return '';
  if (ms < 1000) return ms + 'ms';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return sec + '초';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + '분 ' + (sec % 60) + '초';
  return Math.floor(min / 60) + '시간 ' + (min % 60) + '분';
}

const STATUS_KO = {
  success: '성공', failed: '실패', error: '오류', timeout: '타임아웃',
  running: '실행 중', cancelled: '중지됨', interrupted: '중단됨',
};

// ------------------------------------------------------------------ 목록 렌더링

function render() {
  const list = $('#job-list');
  const empty = $('#empty');

  if (!state.jobs.length) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    $('#subtitle').textContent = '등록된 작업이 없습니다';
    return;
  }
  empty.classList.add('hidden');

  const active = state.jobs.filter(function (j) { return j.enabled; }).length;
  const busy = state.jobs.filter(function (j) { return j.running; }).length;
  $('#subtitle').textContent = '작업 ' + state.jobs.length + '개 · 활성 ' + active + '개'
    + (busy ? ' · 실행 중 ' + busy + '개' : '');

  list.innerHTML = state.jobs.map(function (job) {
    const last = job.lastRun;
    const lastText = job.running
      ? '<span class="status running"><span class="spinner"></span> 실행 중</span>'
      : last
        ? '<span class="status ' + last.status + '">' + (STATUS_KO[last.status] || last.status) + '</span> '
          + fmtTime(last.startedAt) + (last.durationMs ? ' · ' + fmtDuration(last.durationMs) : '')
        : '기록 없음';

    const nextText = !job.enabled ? '비활성'
      : job.nextRunAt ? fmtTime(new Date(job.nextRunAt).toISOString()) + ' (' + fmtRelative(job.nextRunAt) + ')'
      : '예정 없음';

    return '<article class="job' + (job.enabled ? '' : ' disabled') + (job.running ? ' is-running' : '') + '" data-id="' + job.id + '">'
      + '<button class="toggle' + (job.enabled ? ' on' : '') + '" data-action="toggle" title="' + (job.enabled ? '비활성화' : '활성화') + '"></button>'
      + '<div class="job-main">'
      +   '<div class="job-title">'
      +     '<h3>' + esc(job.name) + '</h3>'
      +     '<span class="tag ' + job.type + '">' + (job.type === 'claude' ? 'Claude Code' : '셸') + '</span>'
      +     (job.scheduleError ? '<span class="tag" style="background:var(--err-soft);color:var(--err)">스케줄 오류</span>' : '')
      +     (job.cwdWarning ? '<span class="tag" style="background:var(--warn-soft);color:var(--warn)" title="' + esc(job.cwdWarning) + '">경로 없음</span>' : '')
      +   '</div>'
      +   '<div class="job-meta">'
      +     '<span>🗓 <b>' + esc(job.scheduleText) + '</b> <code>' + esc(job.schedule) + '</code></span>'
      +     '<span>▶ 다음: <b>' + nextText + '</b></span>'
      +     '<span>최근: ' + lastText + '</span>'
      +   '</div>'
      +   (job.notes ? '<div class="job-notes">' + esc(job.notes) + '</div>' : '')
      + '</div>'
      + '<div class="job-actions">'
      +   (job.running
            ? '<button class="btn ghost danger" data-action="cancel">중지</button>'
            : '<button class="btn ghost" data-action="run">지금 실행</button>')
      +   '<button class="btn ghost" data-action="logs">이력</button>'
      +   '<button class="btn ghost" data-action="edit">편집</button>'
      + '</div>'
      + '</article>';
  }).join('');
}

function esc(text) {
  return String(text == null ? '' : text).replace(/[&<>"']/g, function (ch) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
  });
}

async function refresh() {
  const data = await api('/api/state');
  state.jobs = data.jobs;
  state.presets = data.presets;
  state.permissionModes = data.permissionModes;
  state.models = data.models;
  state.platform = data.platform;
  render();
}

// ------------------------------------------------------------------ 편집 패널

function setType(type) {
  state.type = type;
  document.querySelectorAll('#f-type button').forEach(function (b) {
    b.classList.toggle('active', b.dataset.type === type);
  });
  $('#claude-fields').classList.toggle('hidden', type !== 'claude');
  $('#shell-fields').classList.toggle('hidden', type !== 'shell');
}

function openEditor(job) {
  state.editingId = job ? job.id : null;
  $('#editor-title').textContent = job ? '작업 편집' : '새 작업';
  $('#btn-delete').classList.toggle('hidden', !job);
  $('#editor-error').classList.add('hidden');

  $('#f-name').value = job ? job.name : '';
  $('#f-prompt').value = job ? job.prompt || '' : '';
  $('#f-command').value = job ? job.command || '' : '';
  $('#f-cwd').value = job ? job.cwd || '' : '';
  $('#f-cwd-mac').value = job ? job.cwdMac || '' : '';
  $('#f-model').value = job ? job.model || '' : '';
  $('#f-tools').value = job ? job.allowedTools || '' : '';
  $('#f-extra').value = job ? job.extraArgs || '' : '';
  $('#f-notes').value = job ? job.notes || '' : '';
  $('#f-schedule').value = job ? job.schedule : '0 9 * * 1-5';
  $('#f-timeout').value = job ? Math.round((job.timeoutMs || 1800000) / 60000) : 30;
  $('#f-catchup').checked = job ? Boolean(job.catchUp) : false;
  $('#f-preset').value = '';
  $('#f-permission').value = job ? job.permissionMode || 'acceptEdits' : 'acceptEdits';

  setType(job ? job.type : 'claude');
  updatePermissionWarn();
  previewSchedule();

  // 다른 PC에서 동기화된 작업이면 이 PC에 없는 경로일 수 있다.
  const cwdWarn = $('#cwd-warn');
  if (job && job.cwdWarning) {
    cwdWarn.textContent = job.cwdWarning + ' — 이대로 두면 홈 디렉토리에서 실행됩니다.';
    cwdWarn.classList.remove('hidden');
  } else {
    cwdWarn.classList.add('hidden');
  }

  $('#editor-overlay').classList.remove('hidden');
  $('#f-name').focus();
}

function closeEditor() {
  $('#editor-overlay').classList.add('hidden');
  state.editingId = null;
}

function updatePermissionWarn() {
  $('#permission-warn').classList.toggle('hidden', $('#f-permission').value !== 'bypassPermissions');
}

let previewTimer = null;
function previewSchedule() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async function () {
    const box = $('#schedule-preview');
    const schedule = $('#f-schedule').value.trim();
    if (!schedule) {
      box.className = 'preview';
      box.textContent = 'cron 표현식을 입력하거나 위에서 프리셋을 고르세요.';
      return;
    }
    try {
      const data = await api('/api/schedule/preview', { method: 'POST', body: JSON.stringify({ schedule: schedule }) });
      if (!data.ok) {
        box.className = 'preview bad';
        box.textContent = data.error;
        return;
      }
      box.className = 'preview';
      box.innerHTML = '<div class="headline">' + esc(data.text) + '</div>'
        + '<div>다음 실행 예정</div><ol>'
        + data.next.map(function (iso) {
            return '<li>' + new Date(iso).toLocaleString('ko-KR') + '</li>';
          }).join('')
        + '</ol>';
    } catch (err) {
      box.className = 'preview bad';
      box.textContent = err.message;
    }
  }, 200);
}

async function save() {
  const payload = {
    name: $('#f-name').value,
    type: state.type,
    schedule: $('#f-schedule').value,
    cwd: $('#f-cwd').value,
    cwdMac: $('#f-cwd-mac').value,
    timeoutMs: Number($('#f-timeout').value || 30) * 60000,
    catchUp: $('#f-catchup').checked,
    notes: $('#f-notes').value,
    prompt: $('#f-prompt').value,
    command: $('#f-command').value,
    model: $('#f-model').value,
    permissionMode: $('#f-permission').value,
    allowedTools: $('#f-tools').value,
    extraArgs: $('#f-extra').value,
  };

  try {
    let saved;
    if (state.editingId) {
      saved = await api('/api/jobs/' + state.editingId, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      saved = await api('/api/jobs', { method: 'POST', body: JSON.stringify(payload) });
    }
    // 언제 실행되는지가 가장 헷갈리는 지점이라, 저장 직후 다음 실행 시각을 명확히 알린다.
    const when = saved.nextRunAt
      ? new Date(saved.nextRunAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' })
        + ' (' + fmtRelative(saved.nextRunAt) + ')'
      : '예정 없음';
    toast('저장했습니다 · 다음 실행: ' + when);
    closeEditor();
    await refresh();
  } catch (err) {
    const box = $('#editor-error');
    box.textContent = err.message;
    box.classList.remove('hidden');
    // 폼이 길어서 에러가 화면 밖에 있을 수 있으므로 보이는 위치로 옮긴다.
    box.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

// ------------------------------------------------------------------ 실행 이력

async function openLogs(jobId) {
  state.logJobId = jobId;
  state.logRunId = null;
  const job = state.jobs.find(function (j) { return j.id === jobId; });
  $('#logs-title').textContent = '실행 이력 — ' + (job ? job.name : '');
  $('#log-text').textContent = '실행 이력을 선택하세요.';
  $('#log-meta').textContent = '';
  $('#logs-overlay').classList.remove('hidden');
  await loadRuns();
}

async function loadRuns() {
  const data = await api('/api/jobs/' + state.logJobId + '/runs');
  const list = $('#run-list');
  if (!data.runs.length) {
    list.innerHTML = '<p style="padding:12px;color:var(--text-dim);font-size:12.5px">아직 실행된 적이 없습니다.</p>';
    return;
  }
  list.innerHTML = data.runs.map(function (run) {
    const trigger = run.trigger === 'manual' ? '수동' : run.trigger === 'catchup' ? '보정' : '스케줄';
    return '<button class="run-item' + (run.id === state.logRunId ? ' active' : '') + '" data-run="' + run.id + '">'
      + '<div class="when">' + new Date(run.startedAt).toLocaleString('ko-KR') + '</div>'
      + '<div class="info">'
      +   '<span class="status ' + run.status + '">' + (STATUS_KO[run.status] || run.status) + '</span>'
      +   '<span>' + trigger + '</span>'
      +   (run.durationMs ? '<span>' + fmtDuration(run.durationMs) + '</span>' : '')
      + '</div></button>';
  }).join('');

  if (!state.logRunId && data.runs.length) selectRun(data.runs[0].id);
}

async function selectRun(runId) {
  state.logRunId = runId;
  document.querySelectorAll('.run-item').forEach(function (el) {
    el.classList.toggle('active', el.dataset.run === runId);
  });
  const data = await api('/api/jobs/' + state.logJobId + '/runs/' + runId + '/log');
  $('#log-text').textContent = data.text || '(출력이 없습니다)';
  $('#log-meta').textContent = (data.truncated ? '⚠ 로그가 커서 뒷부분만 표시합니다 · ' : '')
    + '크기 ' + (data.size > 1024 ? Math.round(data.size / 1024) + 'KB' : data.size + 'B');
  const pre = $('#log-text');
  pre.scrollTop = pre.scrollHeight;
}

// ------------------------------------------------------------------ 이벤트 배선

document.addEventListener('DOMContentLoaded', async function () {
  // 프리셋 / 권한 모드 채우기
  await refresh();
  $('#f-preset').innerHTML = '<option value="">프리셋에서 고르기…</option>'
    + state.presets.map(function (p) { return '<option value="' + p.value + '">' + p.label + '</option>'; }).join('');
  $('#model-list').innerHTML = (state.models || []).map(function (m) {
    return '<option value="' + m.value + '">' + m.label + '</option>';
  }).join('');
  $('#f-permission').innerHTML = state.permissionModes.map(function (m) {
    const label = { default: 'default — 기본 확인', acceptEdits: 'acceptEdits — 파일 수정 자동 승인',
      plan: 'plan — 계획만 세움', bypassPermissions: 'bypassPermissions — 모든 확인 생략' }[m] || m;
    return '<option value="' + m + '">' + label + '</option>';
  }).join('');
  $('#f-permission').value = 'acceptEdits';

  $('#btn-new').addEventListener('click', function () { openEditor(null); });
  $('#btn-new-empty').addEventListener('click', function () { openEditor(null); });
  $('#editor-close').addEventListener('click', closeEditor);
  $('#btn-cancel').addEventListener('click', closeEditor);
  $('#btn-save').addEventListener('click', save);
  $('#logs-close').addEventListener('click', function () { $('#logs-overlay').classList.add('hidden'); });

  $('#btn-delete').addEventListener('click', async function () {
    const job = state.jobs.find(function (j) { return j.id === state.editingId; });
    if (!job) return;
    if (!confirm('"' + job.name + '" 작업과 실행 이력을 모두 삭제합니다. 계속할까요?')) return;
    await api('/api/jobs/' + job.id, { method: 'DELETE' });
    toast('작업을 삭제했습니다');
    closeEditor();
    await refresh();
  });

  document.querySelectorAll('#f-type button').forEach(function (b) {
    b.addEventListener('click', function () { setType(b.dataset.type); });
  });

  $('#f-preset').addEventListener('change', function () {
    if (this.value) {
      $('#f-schedule').value = this.value;
      previewSchedule();
    }
  });
  $('#f-schedule').addEventListener('input', previewSchedule);
  $('#f-permission').addEventListener('change', updatePermissionWarn);

  // 목록의 버튼들 (이벤트 위임)
  $('#job-list').addEventListener('click', async function (e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const id = btn.closest('.job').dataset.id;
    const job = state.jobs.find(function (j) { return j.id === id; });
    if (!job) return;

    try {
      if (btn.dataset.action === 'toggle') {
        await api('/api/jobs/' + id + '/toggle', { method: 'POST' });
        await refresh();
      } else if (btn.dataset.action === 'run') {
        await api('/api/jobs/' + id + '/run', { method: 'POST' });
        toast('"' + job.name + '" 실행을 시작했습니다');
        await refresh();
      } else if (btn.dataset.action === 'cancel') {
        await api('/api/jobs/' + id + '/cancel', { method: 'POST' });
        toast('중지 요청을 보냈습니다');
      } else if (btn.dataset.action === 'edit') {
        openEditor(job);
      } else if (btn.dataset.action === 'logs') {
        await openLogs(id);
      }
    } catch (err) {
      toast(err.message, 'bad');
    }
  });

  $('#run-list').addEventListener('click', function (e) {
    const item = e.target.closest('.run-item');
    if (item) selectRun(item.dataset.run);
  });

  // 오버레이 바깥 클릭 / ESC 로 닫기
  document.querySelectorAll('.overlay').forEach(function (ov) {
    ov.addEventListener('click', function (e) { if (e.target === ov) ov.classList.add('hidden'); });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') document.querySelectorAll('.overlay').forEach(function (o) { o.classList.add('hidden'); });
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !$('#editor-overlay').classList.contains('hidden')) save();
  });

  // 서버 이벤트 구독 — 실행 시작/종료 시 즉시 갱신
  const es = new EventSource('/api/events');
  es.addEventListener('open', function () { $('#conn').classList.remove('off'); $('#conn').lastElementChild.textContent = '연결됨'; });
  es.addEventListener('error', function () { $('#conn').classList.add('off'); $('#conn').lastElementChild.textContent = '연결 끊김'; });
  ['run-start', 'run-finish', 'jobs-changed'].forEach(function (evt) {
    es.addEventListener(evt, async function (e) {
      await refresh();
      if (evt === 'run-finish' && !$('#logs-overlay').classList.contains('hidden')) {
        const payload = JSON.parse(e.data);
        if (payload.jobId === state.logJobId) { state.logRunId = null; await loadRuns(); }
      }
    });
  });

  // 남은 시간 표시를 위해 30초마다 다시 그린다
  setInterval(render, 30000);
  // 실행 중인 로그를 보고 있으면 주기적으로 갱신한다
  setInterval(function () {
    if (!$('#logs-overlay').classList.contains('hidden') && state.logRunId) {
      const job = state.jobs.find(function (j) { return j.id === state.logJobId; });
      if (job && job.running) selectRun(state.logRunId);
    }
  }, 3000);
});
