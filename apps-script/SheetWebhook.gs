/**
 * 캔뱃지 부스 → 구글 시트 자동 기록용 Apps Script
 *
 * 사용법: 구글 시트 > 확장 프로그램 > Apps Script 에 이 코드를 그대로 붙여넣고,
 * 아래 SECRET 값을 원하는 비밀 문자열로 바꾼 뒤 "웹 앱"으로 배포하세요.
 * (Cloudflare 의 SHEET_WEBHOOK_SECRET 과 같은 값이어야 합니다)
 */
const SECRET = '여기에-비밀문자열-입력';

const LIST_TAB = '대기자 명단';
const SUMMARY_TAB = '실시간 부스 현황';

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const data = JSON.parse(e.postData.contents);
    if (data.secret !== SECRET) {
      return reply({ ok: false, error: 'invalid secret' });
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const list = ss.getSheetByName(LIST_TAB) || ss.insertSheet(LIST_TAB);
    const summary = ss.getSheetByName(SUMMARY_TAB) || ss.insertSheet(SUMMARY_TAB);

    // 대기자 명단: 헤더 + 전체 행을 통째로 다시 씀
    const headers = data.headers;
    const rows = data.rows || [];
    list.getRange(1, 1, 1, headers.length).setValues([headers]);
    const lastRow = list.getLastRow();
    if (lastRow > 1) {
      list.getRange(2, 1, lastRow - 1, headers.length).clearContent();
    }
    if (rows.length > 0) {
      list.getRange(2, 1, rows.length, headers.length).setValues(rows);
    }
    list.setFrozenRows(1);

    // 실시간 부스 현황
    const s = data.summary || [];
    if (s.length > 0) {
      summary.getRange(1, 1, s.length, 2).setValues(s);
    }

    return reply({ ok: true, rows: rows.length });
  } catch (err) {
    return reply({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
