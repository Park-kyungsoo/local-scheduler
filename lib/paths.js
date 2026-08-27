'use strict';

/**
 * 작업 디렉토리 경로 처리.
 *
 * 같은 작업 정의를 Windows 와 macOS 에서 함께 쓰기 위해 두 가지를 지원한다.
 *   1) 앞의 ~ 를 각 PC 의 홈 디렉토리로 확장한다  (~/ai/datahub → C:\Users\...\ai\datahub)
 *   2) macOS 전용 경로(cwdMac)를 따로 둘 수 있다   (Windows 절대경로를 그대로 쓸 수 없을 때)
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

/** 앞의 ~ 를 홈 디렉토리로 바꾼다. */
function expand(p) {
  const text = String(p == null ? '' : p).trim();
  if (!text) return '';
  if (text === '~') return os.homedir();
  if (text.startsWith('~/') || text.startsWith('~\\')) {
    return path.join(os.homedir(), text.slice(2));
  }
  return text;
}

/** 현재 플랫폼에서 실제로 사용할 경로를 고른다 (확장 전 원본). */
function pick(job, platform) {
  const os_ = platform || process.platform;
  if (os_ === 'darwin' && job.cwdMac) return job.cwdMac;
  return job.cwd || '';
}

/** 현재 플랫폼에서 실제로 사용할 경로 (확장 후). */
function resolve(job, platform) {
  return expand(pick(job, platform));
}

/** 지정된 경로가 이 PC 에 존재하는지. 비어 있으면 홈을 쓰므로 문제 없음(null). */
function checkExists(job, platform) {
  const target = resolve(job, platform);
  if (!target) return null;
  if (fs.existsSync(target)) return null;
  return target;
}

module.exports = { expand, pick, resolve, checkExists };
