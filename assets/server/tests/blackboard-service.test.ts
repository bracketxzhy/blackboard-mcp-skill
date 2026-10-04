import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { coursePath, fixtures, membershipPath, response, setup } from './helpers.js';

describe('BlackboardService', () => {
  it('combines only current memberships with course metadata', async () => {
    const { service } = setup();
    expect(await service.getMyCourses()).toEqual([{ internalCourseId: '_1001_1', externalCourseId: 'DEMO-PHYS-01', name: 'Example Physics Course', role: 'TeachingAssistant', ultraStatus: 'Classic', availability: { available: 'Yes' }, lastAccessed: '2026-10-04T01:00:00.000Z' }]);
  });
  it('preserves historical memberships with explicit metadata errors without inventing fields', async () => {
    const { service, get, routes } = setup();
    routes.set(membershipPath, { results: [{ courseId: '_1001_1', courseRoleId: 'TeachingAssistant' }, { courseId: '_old_1', courseRoleId: 'Student' }] });
    const original = get.getMockImplementation();
    if (!original) throw new Error('Missing fixture transport');
    get.mockImplementation(async (url, options) => url.endsWith('/courses/_old_1') ? response({}, 403) : original(url, options));
    expect(await service.getMyCourses()).toEqual([
      expect.objectContaining({ internalCourseId: '_1001_1', name: 'Example Physics Course' }),
      { internalCourseId: '_old_1', externalCourseId: null, name: null, role: 'Student', availability: null, ultraStatus: null, lastAccessed: null, metadataError: { code: 'BlackboardPermissionDenied', message: 'Blackboard GET returned HTTP 403.' } }
    ]);
    await expect(service.getCourse('_old_1')).rejects.toMatchObject({ code: 'BlackboardPermissionDenied' });
    expect(await service.getUpcomingDeadlines()).toHaveLength(1);
  });
  it('does not conceal authentication errors as per-course metadata errors', async () => {
    const { service, get } = setup();
    const original = get.getMockImplementation();
    if (!original) throw new Error('Missing fixture transport');
    get.mockImplementation(async (url, options) => url.endsWith('/courses/_1001_1') ? response({}, 401) : original(url, options));
    await expect(service.getMyCourses()).rejects.toMatchObject({ code: 'AuthenticationRequired' });
  });
  it('reads root folders and Lectures, keeping only the requested content fields', async () => {
    const { service } = setup();
    expect((await service.getCourseContents('_1001_1')).map(value => value.title)).toEqual(['Lectures', 'HW Submission', 'Information', 'Content']);
    expect(await service.getCourseContents('_1001_1', '_2001_1')).toContainEqual(expect.objectContaining({ id: '_2005_1', title: 'Chap 5 Motion I', file: { fileName: 'lesson.pdf', mimeType: 'application/pdf' } }));
    expect(JSON.stringify(await service.getCourseContents('_1001_1', '_2002_1'))).not.toContain('DO-NOT-EXPOSE');
  });
  it('lists attachments as flat files and prevents recursive cycles', async () => {
    const { service, get } = setup();
    expect(await service.getCourseFiles('_1001_1')).toEqual([{ contentId: '_2005_1', title: 'Chap 5 Motion I', attachmentId: '_4001_1', fileName: 'lesson.pdf', mimeType: 'application/pdf', parentPath: 'Lectures / Chap 5 Motion I', created: '2026-10-01T00:00:00.000Z', modified: '2026-10-02T00:00:00.000Z' }]);
    expect(get.mock.calls.filter(([url]) => url.endsWith('_2001_1/children'))).toHaveLength(1);
  });
  it('keeps valid content without a REST handler without inventing its type', async () => {
    const { service, routes } = setup();
    routes.set(`${coursePath}/contents/_2003_1/children`, { results: [{ id: '_notice_1', parentId: '_2003_1', title: 'Course notice', body: 'Notice text' }] });
    const contents = await service.getCourseContents('_1001_1', '_2003_1');
    expect(contents).toEqual([{ id: '_notice_1', parentId: '_2003_1', title: 'Course notice', body: 'Notice text', gradeColumnId: null, file: null }]);
    expect(await service.getAssignments('_1001_1')).toHaveLength(2);
    expect(await service.getCourseFiles('_1001_1')).toHaveLength(1);
    await expect(service.getAssignment('_1001_1', '_notice_1')).rejects.toMatchObject({ code: 'NotAnAssignment' });
  });
  it('returns HW1 and HW2 grade definitions and exact Shanghai deadlines', async () => {
    const { service } = setup();
    expect(await service.getAssignments('_1001_1')).toEqual([
      expect.objectContaining({ contentId: '_2006_1', gradeColumnId: '_3001_1', possibleScore: 100, dueUtc: '2026-09-27T15:59:00.000Z', dueLocal: '2026-09-27 23:59', timezone: 'Asia/Shanghai', attemptsAllowed: 3, scoringModel: 'Last' }),
      expect.objectContaining({ contentId: '_2007_1', gradeColumnId: '_3002_1', possibleScore: 100, dueUtc: '2026-10-07T15:59:00.000Z', dueLocal: '2026-10-07 23:59', timezone: 'Asia/Shanghai', attemptsAllowed: 3, scoringModel: 'Last' })
    ]);
    expect(await service.getAssignment('_1001_1', '_2007_1')).toMatchObject({ title: 'HW2', body: 'HW2 instructions' });
    await expect(service.getAssignment('_1001_1', '_2005_1')).rejects.toMatchObject({ code: 'NotAnAssignment' });
    await expect(service.getAssignment('_1001_1', '_missing_1')).rejects.toMatchObject({ code: 'BlackboardResourceNotFound' });
  });
  it('filters future deadlines and unavailable courses, preserving inclusive boundaries', async () => {
    const { service, routes } = setup();
    expect(await service.getUpcomingDeadlines()).toEqual([expect.objectContaining({ assignmentName: 'HW2', courseId: '_1001_1', dueLocal: '2026-10-07 23:59' })]);
    expect(await service.getUpcomingDeadlines(1)).toEqual([]);
    routes.set(coursePath, { id: '_1001_1', courseId: 'test', name: 'Unavailable', availability: { available: 'No' } });
    const unavailable = setup();
    unavailable.routes.set(coursePath, routes.get(coursePath));
    expect(await unavailable.service.getUpcomingDeadlines()).toEqual([]);
    expect(await unavailable.service.getUpcomingDeadlines(7, '_1001_1')).toHaveLength(1);
    const edge = setup(() => Date.parse('2026-10-07T15:59:00Z'));
    expect(await edge.service.getUpcomingDeadlines(7, '_1001_1')).toHaveLength(1);
    const end = setup(() => Date.parse('2026-09-30T15:59:00Z'));
    expect(await end.service.getUpcomingDeadlines(7, '_1001_1')).toHaveLength(1);
  });
  it('sorts deadlines in ascending UTC order', async () => {
    const { service, routes } = setup();
    routes.set('/learn/api/public/v2/courses/_1001_1/gradebook/columns/_3001_1', { id: '_3001_1', name: 'HW1', grading: { due: '2026-10-06T00:00:00Z' } });
    expect((await service.getUpcomingDeadlines()).map(value => value.assignmentName)).toEqual(['HW1', 'HW2']);
  });
  it('extracts real PDF text and paginates without keeping temporary files', async () => {
    const { service, routes } = setup();
    routes.set(`${coursePath}/contents/_2005_1/attachments/_4001_1/download`, await readFile(new URL('./fixtures/text.pdf', import.meta.url)));
    const first = await service.readCourseFile('_1001_1', '_2005_1', '_4001_1', 0, 1000);
    expect(first.text).toContain('SCUPI physics');
    expect(first).toMatchObject({ offsetChars: 0, returnedChars: 1000, hasMore: true, mimeType: 'application/pdf' });
    const second = await service.readCourseFile('_1001_1', '_2005_1', '_4001_1', first.totalChars, 1000);
    expect(second).toMatchObject({ text: '', returnedChars: 0, hasMore: false });
  });
  it('extracts real DOCX text with mammoth', async () => {
    const { service, routes } = setup();
    routes.set(`${coursePath}/contents/_2005_1/attachments`, { results: [{ id: '_4001_1', fileName: 'syllabus.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }] });
    routes.set(`${coursePath}/contents/_2005_1/attachments/_4001_1/download`, await readFile(new URL('./fixtures/text.docx', import.meta.url)));
    expect(await service.readCourseFile('_1001_1', '_2005_1', '_4001_1')).toMatchObject({ fileName: 'syllabus.docx', text: expect.stringContaining('SCUPI physics syllabus'), hasMore: false });
  });
  it('returns textExtractionUnavailable for blank PDF and corrupt documents', async () => {
    const { service, routes } = setup();
    const path = `${coursePath}/contents/_2005_1/attachments/_4001_1/download`;
    routes.set(path, await readFile(new URL('./fixtures/blank.pdf', import.meta.url)));
    await expect(service.readCourseFile('_1001_1', '_2005_1', '_4001_1')).rejects.toMatchObject({ code: 'textExtractionUnavailable' });
    routes.set(path, Buffer.from('Not a PDF'));
    await expect(service.readCourseFile('_1001_1', '_2005_1', '_4001_1')).rejects.toMatchObject({ code: 'textExtractionUnavailable' });
  });
  it('rejects unknown attachments and unsupported formats without downloading', async () => {
    const { service, routes, get } = setup();
    await expect(service.readCourseFile('_1001_1', '_2005_1', '_999_1')).rejects.toMatchObject({ code: 'BlackboardResourceNotFound' });
    routes.set(`${coursePath}/contents/_2005_1/attachments`, { results: [{ id: '_4001_1', fileName: 'image.png', mimeType: 'image/png' }] });
    await expect(service.readCourseFile('_1001_1', '_2005_1', '_4001_1')).rejects.toMatchObject({ code: 'UnsupportedFileType' });
    expect(get.mock.calls.some(([url]) => url.endsWith('/download'))).toBe(false);
    routes.set(`${coursePath}/contents/_2005_1/attachments`, fixtures['attachments']);
    await expect(service.readCourseFile('_1001_1', '_2005_1', '_4001_1', -1)).rejects.toThrow();
  });
});
