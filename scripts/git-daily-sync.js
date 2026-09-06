#!/usr/bin/env node
'use strict';
/**
 * git 저장소를 하루 한 번 동기화한다: pull -> commit -> push.
 *
 *   node scripts/git-daily-sync.js [저장소경로] [커밋메시지]
 *
 * 저장소 경로를 생략하면 현재 작업 디렉토리를 쓴다. 스케줄러에서는 작업의
 * "작업 디렉토리"만 지정하면 되도록 이렇게 두었다 — macOS 경로 지정도 그대로 먹힌다.
 *
 * 무인 실행이라 사람이 중간에 손댈 수 없다. 그래서:
 * - pull 은 --rebase --autostash 로 돈다. 커밋 안 된 로컬 수정이 있어도 거부되지 않는다
 * - 바뀐 게 없는 날은 커밋을 건너뛴다. "nothing to commit" 으로 실패하지 않는다
 * - 충돌로 rebase 가 멈추면 되돌린다. 저장소가 rebase 중인 채로 남지 않는다
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repo = path.resolve(process.argv[2] || process.cwd());
const message = process.argv[3] || '최신화';

function log(line) {
  process.stdout.write(line + '\n');
}

function fail(msg) {
  process.stderr.write('오류: ' + msg + '\n');
  process.exit(1);
}

/** git 을 돌리고 { code, out } 을 준다. 명령과 출력은 그대로 로그에 남긴다. */
function git(args, options) {
  const allowFail = Boolean(options && options.allowFail);
  // 한국어 Windows 에서도 커밋 메시지·로그가 UTF-8 로 오가게 고정한다.
  const full = ['-c', 'i18n.commitEncoding=UTF-8', '-c', 'i18n.logOutputEncoding=UTF-8'].concat(args);

  log('$ git ' + args.join(' '));
  const res = spawnSync('git', full, { cwd: repo, encoding: 'utf8', windowsHide: true });

  if (res.error) {
    if (allowFail) return { code: -1, out: String(res.error.message) };
    fail('git 을 실행할 수 없다 (PATH 확인) — ' + res.error.message);
  }

  const out = ((res.stdout || '') + (res.stderr || '')).trim();
  if (out) log(out);
  if (res.status !== 0 && !allowFail) {
    fail('git ' + args.join(' ') + ' 실패 (종료코드 ' + res.status + ')');
  }
  return { code: res.status, out: out };
}

if (!fs.existsSync(path.join(repo, '.git'))) {
  fail('git 저장소가 아니다: ' + repo);
}

log('저장소     : ' + repo);
log('커밋 메시지: ' + message);
log('');

// 1) 받기
const pull = git(['pull', '--rebase', '--autostash'], { allowFail: true });
if (pull.code !== 0) {
  // 충돌 등으로 rebase 가 중간에 멈췄으면 원래 상태로 되돌린다.
  // 그대로 두면 다음 실행까지 저장소가 rebase 중인 채로 남는다.
  git(['rebase', '--abort'], { allowFail: true });
  fail('pull 실패 — 저장소를 원래 상태로 되돌렸다. 수동 확인이 필요하다');
}

// 2) 변경분 스테이징
git(['add', '-A']);

// 3) 커밋 — 올릴 게 없는 날은 건너뛴다
const staged = git(['diff', '--cached', '--quiet'], { allowFail: true });
if (staged.code === 0) {
  log('스테이징된 변경 없음 — 커밋을 건너뛴다');
} else {
  git(['commit', '-m', message]);
}

// 4) 올리기 — 올릴 게 없으면 git 이 "Everything up-to-date" 로 끝난다
git(['push']);

log('');
log('완료');
