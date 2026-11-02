// @vitest-environment jsdom
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobsHistoryPanel } from '../src/components/dashboard/JobsHistoryPanel';
import { useFilesAndDlqController } from '../src/components/dashboard/useDashboardResources';
import type { FileWithRemaining } from '../src/components/dashboard/dashboard-types';
import { renderDom, select, visibleText } from './helpers/rendered-dom';
import { testMessages, type TestLocale } from './helpers/intl-messages';

/**
 * What the dashboard tells a person about a file and about a refused action: the time a file has left in the largest
 * sensible unit, and a sentence of the page's language for a refusal, never the server's own text.
 */

const ENGLISH_PHRASE = /[A-Za-z]{2,}[\s,.]+[A-Za-z]{2,}/;
const noop = () => undefined;

function fileWithSecondsLeft(remainingSeconds: number): FileWithRemaining {
  return {
    id: 'f-1', fileName: 'report.pdf', fromFormat: 'pdf', toFormat: 'docx', size: 2_418_112,
    downloadUrl: '/download', createdAt: 0, expiresAt: 0, remainingSeconds,
  } as FileWithRemaining;
}

function retentionCell(remainingSeconds: number, locale: TestLocale): string {
  const dom = renderDom(createElement(JobsHistoryPanel, { files: [fileWithSecondsLeft(remainingSeconds)], loading: false, onRefresh: noop, onDeleteFile: noop }), locale);
  const cells = select(dom, 'td');
  return visibleText(cells[3]);
}

describe('the time a file has left', () => {
  it.each([
    [82_798, '23시간 후 삭제', 'Deleted in 23 hours'],
    [172_800, '2일 후 삭제', 'Deleted in 2 days'],
    [120, '2분 후 삭제', 'Deleted in 2 minutes'],
    [59, '곧 삭제', 'Deleted soon'],
    [0, '곧 삭제', 'Deleted soon'],
  ])('reads %i seconds in the largest unit', (seconds, korean, english) => {
    expect(retentionCell(seconds, 'ko')).toBe(korean);
    expect(retentionCell(seconds, 'en')).toBe(english);
  });
});

describe('a refused deletion of a file', () => {
  let root: Root | undefined;
  afterEach(() => {
    root?.unmount();
    root = undefined;
    vi.unstubAllGlobals();
  });

  async function refusedDeletion(locale: TestLocale, status: number, body: unknown): Promise<string | null> {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/problem+json' } })));
    let reported: string | null = null;
    let controller: ReturnType<typeof useFilesAndDlqController> | undefined;
    function Probe() {
      controller = useFilesAndDlqController(false, (error) => { reported = error; });
      return null;
    }
    root = createRoot(document.createElement('div'));
    root.render(createElement(NextIntlClientProvider, { locale, messages: testMessages(locale), timeZone: 'UTC', children: createElement(Probe) }));
    await vi.waitFor(() => expect(controller).toBeDefined());
    await controller!.handleDeleteFile('f-1');
    return reported;
  }

  const conflict = { type: 'https://api.easyconvert.io/problems/conflict', title: 'Conflict', status: 409, detail: 'The file is still being written and cannot be deleted yet.' };

  it('says in the page language that the file is not ready, with no status code and none of the server text', async () => {
    const korean = await refusedDeletion('ko', 409, conflict);
    expect(korean).toBe('아직 파일을 만드는 중이라 지울 수 없어요. 잠시 후 다시 시도해 주세요.');
    const english = await refusedDeletion('en', 409, conflict);
    expect(english).toBe('The file is still being made, so it cannot be deleted yet. Try again in a moment.');
    for (const sentence of [korean, english]) {
      expect(sentence).not.toContain(conflict.detail);
      expect(sentence).not.toMatch(/409|HTTP/);
    }
  });

  it('words any other refusal by its type or its action, never with the server text', async () => {
    const other = { type: 'https://api.easyconvert.io/problems/retired-problem', status: 400, detail: 'Index entry 7 is dangling.' };
    const korean = await refusedDeletion('ko', 400, other);
    expect(korean).toBe('파일을 삭제하지 못했어요. 잠시 후 다시 시도해 주세요.');
    expect(await refusedDeletion('en', 400, other)).not.toMatch(/dangling|400|HTTP/);
    expect(await refusedDeletion('ko', 404, { type: 'https://api.easyconvert.io/problems/not-found', detail: 'File record not found or not owned by user.' })).not.toMatch(ENGLISH_PHRASE);
  });
});
