'use strict';

/**
 * 자식 프로세스 출력 디코더.
 *
 * 한국어 Windows의 cmd.exe 는 기본 코드페이지(CP949)로 출력하므로 그대로 UTF-8로 읽으면
 * 한글이 깨진다. 반면 Node 기반 도구(Claude Code 등)는 UTF-8로 출력한다.
 * chcp 65001 을 앞에 붙여도 cmd 가 명령행을 이미 ANSI 로 파싱한 뒤라 소용이 없어서,
 * 출력 바이트를 보고 인코딩을 판정한다.
 *
 * 판정은 처음 등장한 비ASCII 청크로 한 번만 하고 이후에는 고정한다.
 * 멀티바이트 문자가 청크 경계에 걸리는 문제는 두 디코더 모두 스트리밍 모드로 처리한다.
 */

const { StringDecoder } = require('node:string_decoder');

const IS_WIN = process.platform === 'win32';

/** 버퍼 전체가 ASCII 범위인지 (인코딩 판정을 미뤄도 되는지) */
function isAscii(buf) {
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] >= 0x80) return false;
  }
  return true;
}

/**
 * 버퍼가 유효한 UTF-8 인지 검사한다.
 * 버퍼 끝에서 잘린 불완전한 시퀀스는 유효한 것으로 본다(다음 청크에서 이어짐).
 */
function isValidUtf8(buf) {
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];
    let need;
    if (b < 0x80) { i += 1; continue; }
    else if (b >= 0xc2 && b <= 0xdf) need = 1;
    else if (b >= 0xe0 && b <= 0xef) need = 2;
    else if (b >= 0xf0 && b <= 0xf4) need = 3;
    else return false; // 연속 바이트가 선두에 오거나 잘못된 선두 바이트

    // 끝에서 잘린 시퀀스는 통과시킨다.
    if (i + need >= buf.length) return true;
    for (let k = 1; k <= need; k += 1) {
      if ((buf[i + k] & 0xc0) !== 0x80) return false;
    }
    i += need + 1;
  }
  return true;
}

/**
 * 스트리밍 디코더를 만든다.
 * @param {'utf8'|'auto'} mode  'utf8' 이면 판정 없이 UTF-8로 고정한다.
 */
function createDecoder(mode) {
  const utf8 = new StringDecoder('utf8');
  let legacy = null;
  let resolved = mode === 'utf8' || !IS_WIN ? 'utf8' : null;

  function legacyDecoder() {
    if (!legacy) {
      try {
        legacy = new TextDecoder('euc-kr');
      } catch (err) {
        legacy = null; // ICU 가 없는 빌드면 UTF-8로 처리한다
      }
    }
    return legacy;
  }

  return function decode(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

    if (resolved === null) {
      // 비ASCII 바이트가 나오기 전까지는 판정을 미룬다.
      if (isAscii(buf)) return buf.toString('latin1');
      resolved = isValidUtf8(buf) ? 'utf8' : 'legacy';
    }

    if (resolved === 'utf8') return utf8.write(buf);

    const dec = legacyDecoder();
    if (!dec) return buf.toString('utf8');
    return dec.decode(buf, { stream: true });
  };
}

module.exports = { createDecoder, isValidUtf8, isAscii };
