import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { selectLatest, identity, inside, createReader, gradingCheck, exportLatest } from './workflow.mjs';

const attempt = (id, userId, date, extra = {}) => ({ id, userId, status: 'NeedsGrading', attemptDate: date, ...extra });
test('Latest selection ignores drafts, keeps newer empty submissions, and resolves created-time ties', () => {
  const result = selectLatest([
    attempt('_1_1', '_11_1', '2026-09-01T00:00:00Z'),
    attempt('_2_1', '_11_1', '2026-09-02T00:00:00Z', { studentSubmission: '' }),
    attempt('_3_1', '_11_1', '2026-09-03T00:00:00Z', { status: 'InProgress' }),
    attempt('_4_1', '_12_1', '2026-09-02T00:00:00Z', { created: '2026-09-01T00:00:00Z' }),
    attempt('_5_1', '_12_1', '2026-09-02T00:00:00Z', { created: '2026-09-02T00:00:00Z' })
  ]);
  assert.deepEqual(result.map(a => a.id), ['_2_1', '_5_1']);
});
test('Ambiguous timestamps, missing dates, and group submissions fail explicitly', () => {
  assert.throws(() => selectLatest([attempt('_1_1', '_11_1', '2026-09-01T00:00:00Z'), attempt('_2_1', '_11_1', '2026-09-01T00:00:00Z')]));
  assert.throws(() => selectLatest([{ id: '_1_1', userId: '_11_1', status: 'NeedsGrading' }]));
  assert.throws(() => selectLatest([attempt('_1_1', '_11_1', '2026-09-01T00:00:00Z', { groupAttemptId: '_9_1' })]));
});
test('Student number never silently falls back to username or Blackboard ID', () => {
  const profile = { id: '_4321_1', name: { given: 'Test', family: 'Student' }, userName: '202600001234' };
  assert.throws(() => identity(profile));
  assert.equal(identity(profile, 'username').studentIdLast4, '1234');
  assert.equal(identity({ ...profile, studentId: 'S00005678' }).studentIdLast4, '5678');
  assert.equal(identity(profile, 'username').name, 'Test Student');
});
test('Output paths cannot escape the selected directory', () => {
  assert.throws(() => inside(join(tmpdir(), 'chosen'), '..', 'outside.pdf'));
  assert.throws(() => inside(join(tmpdir(), 'chosen'), join(tmpdir(), 'outside.pdf')));
});
test('Reader exposes only GET and refuses pagination to another origin or endpoint', async () => {
  const seen = [];
  const request = { get: async (url, opts) => {
    seen.push({ url, opts });
    return { status: () => 200, json: async () => ({ results: [], paging: { nextPage: 'https://other.example/learn/api/public/v1/items' } }), dispose: async () => {} };
  } };
  const reader = createReader(request, 'https://blackboard.example');
  assert.deepEqual(Object.keys(reader).sort(), ['download', 'json', 'list']);
  // Use the runtime's external response schema through a legitimate parser.
  const { createRequire } = await import('node:module');
  const require = createRequire(new URL('../assets/server/package.json', import.meta.url));
  const { z } = require('zod');
  await assert.rejects(reader.list('/learn/api/public/v1/items', z.object({})), /origin/);
  assert.equal(seen[0].opts.maxRedirects, 0);
  await assert.rejects(reader.json('https://other.example/learn/api/public/v1/items'));
});
test('Grading probe reads id/status only, has no userId filter, and never claims successful writes', async () => {
  const calls = [];
  const result = await gradingCheck({ json: async path => { calls.push(path); return { results: [{ id: '_1_1', status: 'NeedsGrading' }] }; } }, '_8_1', [{ title: 'HW1', gradeColumnId: '_9_1' }], 'TeachingAssistant');
  assert.equal(result.actualGradeWriteVerified, false); assert.equal(result.writeRequests, 0); assert.equal(result.inconclusive, false);
  assert.match(calls[0], /fields=id,status&limit=1$/u); assert.doesNotMatch(calls[0], /userId|score|feedback/iu);
  assert.equal((await gradingCheck({}, '_8_1', [], 'TeachingAssistant')).inconclusive, true);
});
test('Authentication loss stops grading checks instead of trying another assignment', async () => {
  let calls = 0;
  const reader = { json: async () => { calls++; const e = new Error('HTTP 401'); e.httpStatus = 401; throw e; } };
  await assert.rejects(gradingCheck(reader, '_8_1', [{ title: 'HW1', gradeColumnId: '_9_1' }, { title: 'HW2', gradeColumnId: '_10_1' }], 'TeachingAssistant'));
  assert.equal(calls, 1);
});
test('Export layout has single files, multi-file folders, latest-empty metadata, and preserves original bytes', async () => {
  const sandbox = await mkdtemp(join(tmpdir(), 'blackboard-skill-test-'));
  try {
    const identities = {
      '_11_1': { id: '_11_1', name: { given: 'One', family: 'Student' }, studentId: '202600001111' },
      '_12_1': { id: '_12_1', name: { given: 'Two', family: 'Student' }, studentId: '202600002222' },
      '_13_1': { id: '_13_1', name: { given: 'Three', family: 'Student' }, studentId: '202600003333' }
    };
    const downloadPaths = [];
    const reader = {
      json: async path => path.includes('/attempts?') ? { results: [{ id: '_100_1', status: 'NeedsGrading' }] } : identities[path.split('/users/')[1].split('?')[0]],
      list: async path => path.includes('/columns/') ? [
        attempt('_100_1', '_11_1', '2026-09-01T00:00:00Z'),
        attempt('_101_1', '_11_1', '2026-09-02T00:00:00Z'),
        attempt('_102_1', '_12_1', '2026-09-02T00:00:00Z'),
        attempt('_103_1', '_13_1', '2026-09-01T00:00:00Z'),
        attempt('_104_1', '_13_1', '2026-09-02T00:00:00Z')
      ] : path.includes('_101_1') ? [{ id: '_201_1', name: 'original.pdf' }] : path.includes('_102_1') ? [{ id: '_202_1', name: 'page.jpg' }, { id: '_203_1', name: 'page.jpg' }] : [],
      download: async path => { downloadPaths.push(path); return { bytes: Buffer.from('unchanged fixture bytes'), warnings: [] }; }
    };
    const root = join(sandbox, 'export');
    const result = await exportLatest(reader, '_8_1', [{ title: 'HW1', contentId: '_7_1', gradeColumnId: '_9_1' }], root);
    const items = await readdir(join(root, 'HW1'), { withFileTypes: true });
    assert.equal(items.filter(i => i.isDirectory()).length, 1);
    assert.ok(items.some(i => i.name === 'HW1-One Student-1111.pdf' && i.isFile()));
    assert.deepEqual((await readdir(join(root, 'HW1', 'HW1-Two Student-2222'))).sort(), ['2-page.jpg', 'page.jpg']);
    assert.equal(result.summary.fileCount, 3); assert.equal(result.summary.sha256Verified, true); assert.equal(result.summary.noAttachmentAttempts, 1);
    assert.equal(result.assignments[0].attempts.find(a => a.userId === '_13_1').attemptId, '_104_1');
    assert.ok(downloadPaths.every(p => !p.includes('_100_1') && !p.includes('_103_1')));
    assert.equal(await readFile(join(root, 'HW1', 'HW1-One Student-1111.pdf'), 'utf8'), 'unchanged fixture bytes');
    await assert.rejects(exportLatest(reader, '_8_1', [{ title: 'HW1', contentId: '_7_1', gradeColumnId: '_9_1' }], root), /EEXIST/);
  } finally {
    assert.equal(resolve(dirname(sandbox)), resolve(tmpdir()));
    assert.ok(basename(sandbox).startsWith('blackboard-skill-test-'));
    await rm(sandbox, { recursive: true, force: true });
  }
});
test('Download preserves corrupt PDF bytes with a warning and refuses HTTP redirect downgrade', async () => {
  const invalid = Buffer.from('{"error":"original upload"}');
  const reader = createReader({ get: async () => ({ status: () => 200, headers: () => ({ 'content-type': 'application/json', 'content-disposition': 'attachment' }), body: async () => invalid, dispose: async () => {} }) }, 'https://blackboard.example');
  const result = await reader.download('/learn/api/public/v1/file/download', 'student.pdf');
  assert.deepEqual(result.bytes, invalid); assert.equal(result.warnings.length, 1);
  const redirect = createReader({ get: async () => ({ status: () => 302, headers: () => ({ location: 'http://blackboard.example/file' }), dispose: async () => {} }) }, 'https://blackboard.example');
  await assert.rejects(redirect.download('/learn/api/public/v1/file/download', 'student.pdf'), /Unsafe/);
});
test('An HTML filename does not allow a 200 login page to be exported as a submission', async () => {
  const login = createReader({ get: async () => ({ status: () => 200, headers: () => ({ 'content-type': 'text/html' }), body: async () => Buffer.from('<form action="/login">Password</form>'), dispose: async () => {} }) }, 'https://blackboard.example');
  await assert.rejects(login.download('/learn/api/public/v1/file/download', 'student.html'), /HTML page/);
  const actual = createReader({ get: async () => ({ status: () => 200, headers: () => ({ 'content-type': 'text/html', 'content-disposition': 'attachment; filename="student.html"' }), body: async () => Buffer.from('<p>Original HTML attachment</p>'), dispose: async () => {} }) }, 'https://blackboard.example');
  assert.equal((await actual.download('/learn/api/public/v1/file/download', 'student.html')).bytes.toString(), '<p>Original HTML attachment</p>');
});
