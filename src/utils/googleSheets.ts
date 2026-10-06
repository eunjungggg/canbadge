import type { AdminQueueItemDTO } from '../types';

export interface SheetSyncResult {
  spreadsheetId: string;
  spreadsheetUrl: string;
  rowsCount: number;
}

export async function createGoogleSheet(
  accessToken: string,
  title = '캔뱃지 체험 부스 실시간 대기 명단 - 진로박람회'
): Promise<SheetSyncResult> {
  const res = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      properties: {
        title,
      },
      sheets: [
        {
          properties: {
            title: '대기자 명단',
            gridProperties: {
              frozenRowCount: 1,
            },
          },
        },
        {
          properties: {
            title: '실시간 부스 현황',
            gridProperties: {
              frozenRowCount: 1,
            },
          },
        },
      ],
    }),
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData?.error?.message || '구글 스프레드시트 생성에 실패했습니다.');
  }

  const data = await res.json();
  const spreadsheetId = data.spreadsheetId;
  const spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;

  return {
    spreadsheetId,
    spreadsheetUrl,
    rowsCount: 0,
  };
}

export async function syncQueueDataToSheet(
  accessToken: string,
  spreadsheetId: string,
  items: AdminQueueItemDTO[]
): Promise<void> {
  const headers = [
    '대기 번호',
    '학생 이름',
    '학교명',
    '진행 상태',
    '배정 기계',
    '호출 횟수',
    '접수 시각',
    '호출 시각',
    '사진 편집 시작',
    '프레스 제작 시작',
    '체험 완료 시각',
  ];

  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'WAITING':
        return '대기 중';
      case 'CALLED':
        return '호출 중';
      case 'PHOTO_EDITING':
        return '사진 편집/출력';
      case 'ASSIGNED_PRESS_1':
        return '1번 프레스';
      case 'ASSIGNED_PRESS_2':
        return '2번 프레스';
      case 'COMPLETED':
        return '완료';
      case 'ABSENT':
        return '부재';
      case 'RE_WAITING':
        return '재대기';
      case 'CANCELLED':
        return '취소';
      default:
        return status;
    }
  };

  const rows = items.map((i) => [
    i.ticketNumber,
    i.name,
    i.school,
    getStatusLabel(i.status),
    i.assignedSlot ? `${i.assignedSlot}호기` : '-',
    i.callCount,
    i.registeredAt ? new Date(i.registeredAt).toLocaleString('ko-KR') : '',
    i.calledAt ? new Date(i.calledAt).toLocaleString('ko-KR') : '',
    i.editingStartedAt ? new Date(i.editingStartedAt).toLocaleString('ko-KR') : '',
    i.pressStartedAt ? new Date(i.pressStartedAt).toLocaleString('ko-KR') : '',
    i.completedAt ? new Date(i.completedAt).toLocaleString('ko-KR') : '',
  ]);

  const applicantValues = [headers, ...rows];
  const range = `대기자 명단!A1:K${applicantValues.length}`;

  // Write applicants list
  const res1 = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(
      range
    )}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        range,
        majorDimension: 'ROWS',
        values: applicantValues,
      }),
    }
  );

  if (!res1.ok) {
    const errData = await res1.json().catch(() => ({}));
    throw new Error(errData?.error?.message || '구글 시트 대기자 명단 쓰기에 실패했습니다.');
  }

  // Write Summary KPI tab
  const totalWaiting = items.filter((i) => i.status === 'WAITING' || i.status === 'RE_WAITING').length;
  const totalCompleted = items.filter((i) => i.status === 'COMPLETED').length;
  const currentDesk = items.find((i) => i.status === 'PHOTO_EDITING' || i.status === 'CALLED');
  const press1 = items.find((i) => i.status === 'ASSIGNED_PRESS_1');
  const press2 = items.find((i) => i.status === 'ASSIGNED_PRESS_2');

  const summaryValues = [
    ['부스 운영 지표', '실시간 현황 값'],
    ['총 접수 인원', items.length],
    ['현재 대기 인원', totalWaiting],
    ['체험 완료 인원', totalCompleted],
    ['사진 접수대 진행 번호', currentDesk ? currentDesk.ticketNumber : '비어 있음'],
    ['프레스 1호기 진행 번호', press1 ? press1.ticketNumber : '비어 있음'],
    ['프레스 2호기 진행 번호', press2 ? press2.ticketNumber : '비어 있음'],
    ['마지막 시트 동기화 시각', new Date().toLocaleString('ko-KR')],
  ];

  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/실시간%20부스%20현황!A1:B8?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        range: '실시간 부스 현황!A1:B8',
        majorDimension: 'ROWS',
        values: summaryValues,
      }),
    }
  ).catch((e) => console.warn('Summary sheet update skipped', e));
}

export async function clearGoogleSheetData(
  accessToken: string,
  spreadsheetId: string
): Promise<void> {
  const headers = [
    '대기 번호',
    '학생 이름',
    '학교명',
    '진행 상태',
    '배정 기계',
    '호출 횟수',
    '접수 시각',
    '호출 시각',
    '사진 편집 시작',
    '프레스 제작 시작',
    '체험 완료 시각',
  ];

  // 1. Batch clear candidate ranges
  try {
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchClear`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ranges: [
          "'대기자 명단'!A2:K2000",
          "대기자 명단!A2:K2000",
        ],
      }),
    });
  } catch (e) {
    console.warn('batchClear warning', e);
  }

  // 2. Clear using values/{range}:clear with unencoded '!'
  try {
    const range1 = encodeURIComponent('대기자 명단') + '!A2:K2000';
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range1}:clear`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );
  } catch (e) {
    console.warn('range clear warning', e);
  }

  // 3. Write fresh headers at A1:K1
  try {
    const headerRange = encodeURIComponent('대기자 명단') + '!A1:K1';
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${headerRange}?valueInputOption=USER_ENTERED`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          range: '대기자 명단!A1:K1',
          majorDimension: 'ROWS',
          values: [headers],
        }),
      }
    );
  } catch (e) {
    console.warn('Header rewrite warning', e);
  }

  // 4. Reset Summary tab to zero state
  const resetSummaryValues = [
    ['부스 운영 지표', '실시간 현황 값'],
    ['총 접수 인원', 0],
    ['현재 대기 인원', 0],
    ['체험 완료 인원', 0],
    ['사진 접수대 진행 번호', '비어 있음'],
    ['프레스 1호기 진행 번호', '비어 있음'],
    ['프레스 2호기 진행 번호', '비어 있음'],
    ['마지막 초기화 시각', new Date().toLocaleString('ko-KR')],
  ];

  try {
    const summaryRange = encodeURIComponent('실시간 부스 현황') + '!A1:B8';
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${summaryRange}?valueInputOption=USER_ENTERED`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          range: '실시간 부스 현황!A1:B8',
          majorDimension: 'ROWS',
          values: resetSummaryValues,
        }),
      }
    );
  } catch (e) {
    console.warn('Summary sheet reset warning', e);
  }
}

