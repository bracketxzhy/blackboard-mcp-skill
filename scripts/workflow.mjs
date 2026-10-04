#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, sep, extname, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../assets/server/package.json', import.meta.url));
const { z } = require('zod');
const idSchema = z.string().regex(/^_[0-9]+_[0-9]+$/u);
const dateSchema = z.string().datetime();
const attemptSchema = z.object({ id: idSchema, userId: idSchema.optional(), groupAttemptId: idSchema.nullish(), status: z.string(), attemptDate: dateSchema.optional(), created: dateSchema.optional(), studentSubmission: z.string().nullish() });
const attachmentSchema = z.object({ id: idSchema, name: z.string().min(1) });
const submitted = new Set(['NeedsGrading', 'Completed', 'NeedsGradingAgain', 'InProgressAgain']);
const digest = buffer => createHash('sha256').update(buffer).digest('hex');

export function safeName(value) {
  const cleaned = value.normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').replace(/[. ]+$/u, '').slice(0, 100);
  if (!cleaned || cleaned === '.' || cleaned === '..') throw new Error('Empty or invalid filename');
  return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(cleaned) ? `_${cleaned}` : cleaned;
}

export function inside(root, ...parts) {
  const absoluteRoot = resolve(root);
  const path = resolve(absoluteRoot, ...parts);
  const normalizedPath = process.platform === 'win32' ? path.toLowerCase() : path;
  const normalizedRoot = process.platform === 'win32' ? absoluteRoot.toLowerCase() : absoluteRoot;
  if (!normalizedPath.startsWith(normalizedRoot + sep)) throw new Error('Output path escaped destination');
  return path;
}

export function selectLatest(rawAttempts) {
  const attempts = z.array(attemptSchema).parse(rawAttempts);
  const latest = new Map();
  for (const attempt of attempts.filter(a => submitted.has(a.status))) {
    if (attempt.groupAttemptId) throw new Error('Group submissions require a different layout; no individual identity invented');
    if (!attempt.userId || !attempt.attemptDate) throw new Error('Submitted attempt missing user or submission date');
    const previous = latest.get(attempt.userId);
    if (!previous) { latest.set(attempt.userId, attempt); continue; }
    const delta = Date.parse(attempt.attemptDate) - Date.parse(previous.attemptDate);
    const createdDelta = Date.parse(attempt.created ?? attempt.attemptDate) - Date.parse(previous.created ?? previous.attemptDate);
    if (delta > 0 || (delta === 0 && createdDelta > 0)) latest.set(attempt.userId, attempt);
    else if (delta === 0 && createdDelta === 0 && attempt.id !== previous.id) throw new Error('Latest attempt is ambiguous; no arbitrary ID ordering');
  }
  return [...latest.values()];
}

export function identity(raw, source = 'studentId', order = 'auto') {
  z.enum(['studentId', 'username']).parse(source); z.enum(['auto', 'family-given', 'given-family']).parse(order);
  const profile = z.object({ id: idSchema, studentId: z.string().optional(), userName: z.string().optional(), name: z.object({ given: z.string().optional(), family: z.string().optional() }) }).parse(raw);
  const number = (source === 'username' ? profile.userName : profile.studentId)?.trim();
  if (!number || !/\d{4}$/u.test(number)) throw new Error(`No student number ending in four digits from configured ${source} source`);
  const given = profile.name.given?.trim() ?? ''; const family = profile.name.family?.trim() ?? '';
  if (!given && !family) throw new Error('Submitting user has no name');
  const familyFirst = order === 'family-given' || (order === 'auto' && /\p{Script=Han}/u.test(given + family));
  const name = familyFirst ? family + given : [given, family].filter(Boolean).join(' ');
  return { userId: profile.id, name, studentIdLast4: number.slice(-4), studentNumberSource: source };
}

export function createReader(request, baseUrl) {
  const origin = new URL(baseUrl).origin;
  function endpoint(path) {
    const url = new URL(path, origin);
    if (url.origin !== origin || !url.pathname.startsWith('/learn/api/public/') || url.username || url.password || url.hash) throw new Error('Request left predefined Blackboard API origin');
    return url;
  }
  async function response(path, download = false) {
    let url = endpoint(path);
    for (let redirect = 0; redirect <= 10; redirect++) {
      const result = await request.get(url.href, { failOnStatusCode: false, maxRedirects: 0, timeout: 120000 });
      const status = result.status();
      if (download && status >= 300 && status < 400) {
        const location = result.headers()['location']; await result.dispose();
        if (!location) throw new Error('Attachment redirect missing Location');
        const next = new URL(location, url);
        if (next.protocol !== 'https:' || next.username || next.password || next.hash || /\/login(?:[/?]|$)/iu.test(next.pathname)) throw new Error('Unsafe or login attachment redirect');
        url = next; continue;
      }
      if (status !== 200) {
        await result.dispose();
        const error = new Error(`Blackboard GET returned HTTP ${status}`);
        error.httpStatus = status;
        throw error;
      }
      return result;
    }
    throw new Error('Too many attachment redirects');
  }
  async function json(path) {
    const result = await response(path);
    try { return await result.json(); } finally { await result.dispose(); }
  }
  async function list(path, schema) {
    const first = endpoint(path); let current = first; const seen = new Set(); const items = [];
    const pageSchema = z.object({ results: z.array(schema), paging: z.object({ nextPage: z.string().optional() }).optional() });
    while (current) {
      if (seen.has(current.href) || seen.size >= 1000) throw new Error('Invalid or excessive pagination');
      seen.add(current.href);
      const page = pageSchema.parse(await json(current.href)); items.push(...page.results);
      if (!page.paging?.nextPage) break;
      const next = endpoint(new URL(page.paging.nextPage, current).href);
      if (next.pathname !== first.pathname) throw new Error('Pagination left predefined endpoint');
      current = next;
    }
    return items;
  }
  async function download(path, name) {
    const result = await response(path, true);
    try {
      const headers = result.headers();
      if ((headers['content-type'] ?? '').toLowerCase().includes('text/html') && !/^\s*attachment(?:;|\s*$)/iu.test(headers['content-disposition'] ?? '')) throw new Error('Attachment endpoint returned an HTML page without attachment disposition');
      const bytes = await result.body();
      if (bytes.length > 200 * 1024 * 1024) throw new Error('Attachment exceeds the 200 MiB export limit');
      const warnings = [];
      if (!bytes.length) warnings.push('Original attachment is empty');
      if (/\.pdf$/iu.test(name) && !bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) warnings.push('Original filename is .pdf but bytes have no PDF header; preserved unchanged');
      return { bytes, warnings };
    } finally { await result.dispose(); }
  }
  return { json, list, download };
}

function attemptEndpoint(courseId, columnId) {
  idSchema.parse(courseId); idSchema.parse(columnId);
  return `/learn/api/public/v2/courses/${courseId}/gradebook/columns/${columnId}/attempts`;
}

export async function gradingCheck(reader, courseId, assignments, role) {
  const checks = [];
  for (const assignment of assignments) {
    const path = attemptEndpoint(courseId, assignment.gradeColumnId) + '?fields=id,status&limit=1';
    try {
      const result = z.object({ results: z.array(z.object({ id: idSchema, status: z.string() })) }).parse(await reader.json(path));
      checks.push({ assignment: assignment.title, httpStatus: 200, sampleCount: result.results.length, permissionEvidence: 'Unfiltered column-attempts GET succeeded; public API documents course.gradebook.MODIFY' });
    } catch (error) {
      if (error.httpStatus === 401) throw error;
      checks.push({ assignment: assignment.title, httpStatus: error.httpStatus ?? null, error: error.httpStatus ? `GET failed HTTP ${error.httpStatus}` : 'Permission check failed' });
      break;
    }
  }
  return { courseId, role, checkedAtUtc: new Date().toISOString(), readOnly: true, writeRequests: 0, actualGradeWriteVerified: false, inconclusive: assignments.length === 0 || checks.some(c => c.httpStatus !== 200), checks };
}

export async function exportLatest(reader, courseId, assignments, out, source = 'studentId', order = 'auto') {
  idSchema.parse(courseId);
  const selected = [];
  const titles = new Set();
  for (const assignment of assignments) {
    const title = safeName(assignment.title);
    if (titles.has(title.toLowerCase())) throw new Error('Assignment directory collision');
    titles.add(title.toLowerCase());
    const check = await gradingCheck(reader, courseId, [assignment], 'server-checked');
    if (check.inconclusive) throw new Error('Staff gradebook permission check failed; no student data read');
    const endpoint = attemptEndpoint(courseId, assignment.gradeColumnId);
    const attempts = await reader.list(endpoint + '?fields=id,userId,groupAttemptId,status,attemptDate,created,studentSubmission', attemptSchema);
    selected.push({ assignment, title, latest: selectLatest(attempts) });
  }
  const profiles = new Map();
  const userIds = [...new Set(selected.flatMap(s => s.latest.map(a => a.userId)))];
  for (const id of userIds) {
    idSchema.parse(id);
    const fields = source === 'username' ? 'id,name,userName' : 'id,name,studentId';
    const person = identity(await reader.json(`/learn/api/public/v1/users/${id}?fields=${fields}`), source, order);
    if (person.userId !== id) throw new Error('User identity mismatch');
    profiles.set(id, person);
  }
  const root = resolve(out); await mkdir(dirname(root), { recursive: true }); await mkdir(root); // EEXIST is intentional; never replace user data.
  const manifest = { courseId, exportedAtUtc: new Date().toISOString(), readOnly: true, latestOnly: true, studentNumberSource: source, destination: root, assignments: [], errors: [], summary: null };
  const allFiles = [];
  try {
    for (const { assignment, title, latest } of selected) {
      const directory = inside(root, title); await mkdir(directory);
      const entries = []; const occupied = new Set();
      for (const attempt of latest) {
        const person = profiles.get(attempt.userId);
        const stem = safeName(`${title.slice(0, 35)}-${safeName(person.name).slice(0, 35)}-${person.studentIdLast4}`);
        if (occupied.has(stem.toLowerCase())) throw new Error('Student filename collision');
        occupied.add(stem.toLowerCase());
        const fileEndpoint = `/learn/api/public/v1/courses/${courseId}/gradebook/attempts/${attempt.id}/files`;
        const files = await reader.list(fileEndpoint, attachmentSchema);
        const output = files.length > 1 ? inside(directory, stem) : directory;
        if (files.length > 1) await mkdir(output);
        const saved = []; const filenames = new Set();
        for (const [index, file] of files.entries()) {
          let filename = files.length === 1 ? safeName(stem + extname(file.name)) : safeName(file.name);
          if (filenames.has(filename.toLowerCase())) filename = safeName(`${index + 1}-${filename}`);
          if (filenames.has(filename.toLowerCase())) throw new Error('Attachment filename collision');
          filenames.add(filename.toLowerCase());
          const data = await reader.download(`${fileEndpoint}/${file.id}/download`, file.name);
          const localPath = inside(output, filename);
          await writeFile(localPath, data.bytes, { flag: 'wx' });
          const entry = { attachmentId: file.id, originalName: file.name, localPath, bytes: data.bytes.length, sha256: digest(data.bytes), warnings: data.warnings };
          saved.push(entry); allFiles.push(entry);
        }
        let textFile = null;
        if (!files.length && attempt.studentSubmission?.trim()) {
          const localPath = inside(directory, stem + '.html'); const bytes = Buffer.from(attempt.studentSubmission);
          await writeFile(localPath, bytes, { flag: 'wx' });
          textFile = { localPath, bytes: bytes.length, sha256: digest(bytes), warnings: [] }; allFiles.push(textFile);
        }
        entries.push({ attemptId: attempt.id, ...person, status: attempt.status, submittedAtUtc: attempt.attemptDate, files: saved, textFile, noAttachment: files.length === 0 });
      }
      manifest.assignments.push({ title, contentId: assignment.contentId, gradeColumnId: assignment.gradeColumnId, latestStudentCount: latest.length, attempts: entries });
      await writeFile(inside(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
    }
    for (const file of allFiles) {
      const bytes = await readFile(file.localPath);
      if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw new Error('Export integrity verification failed');
    }
    manifest.summary = { studentCount: profiles.size, assignmentCount: selected.length, selectedAttempts: selected.reduce((n, s) => n + s.latest.length, 0), attachmentCount: manifest.assignments.flatMap(a => a.attempts).reduce((n, a) => n + a.files.length, 0), fileCount: allFiles.length, warningFiles: allFiles.filter(f => f.warnings.length).length, noAttachmentAttempts: manifest.assignments.flatMap(a => a.attempts).filter(a => a.noAttachment).length, sha256Verified: true };
    await writeFile(inside(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
    return manifest;
  } catch (error) {
    manifest.errors.push({ message: error instanceof Error ? error.message : 'Export failed' });
    await writeFile(inside(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
    throw error;
  }
}

async function main(args) {
  const [command, ...flags] = args;
  if (command === '--help' || !command) {
    console.log('Usage: workflow.mjs courses | grading-check --course _123_1 | export-latest --course _123_1 --out NEW_DIR [--student-id-source studentId|username] [--name-order auto|family-given|given-family]'); return;
  }
  const parsed = {};
  for (let index = 0; index < flags.length; index += 2) {
    const key = flags[index]; const value = flags[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--') || key in parsed) throw new Error('Invalid, duplicate or incomplete CLI options');
    parsed[key] = value;
  }
  const options = command === 'courses' ? z.strictObject({}).parse(parsed) : command === 'grading-check'
    ? z.strictObject({ '--course': idSchema }).parse(parsed)
    : command === 'export-latest' ? z.strictObject({ '--course': idSchema, '--out': z.string().min(1), '--student-id-source': z.enum(['studentId', 'username']).default('studentId'), '--name-order': z.enum(['auto', 'family-given', 'given-family']).default('auto') }).parse(parsed)
      : (() => { throw new Error('Unknown command; no write/grading command exists'); })();
  const { loadConfig } = await import('../assets/server/dist/src/config.js');
  const { openBrowser } = await import('../assets/server/dist/src/auth.js');
  const { BlackboardClient } = await import('../assets/server/dist/src/blackboard-client.js');
  const { BlackboardService } = await import('../assets/server/dist/src/blackboard-service.js');
  const config = loadConfig(); const context = await openBrowser(config);
  try {
    const client = new BlackboardClient(context.request, config.baseUrl); const service = new BlackboardService(client);
    const memberships = await client.getMemberships(true);
    if (command === 'courses') { console.log(JSON.stringify(await service.getMyCourses(), null, 2)); return; }
    const courseId = options['--course']; await client.assertCourseAccess(courseId);
    const role = memberships.find(m => m.courseId === courseId)?.courseRoleId;
    const assignments = await service.getAssignments(courseId);
    const reader = createReader(context.request, config.baseUrl);
    const result = command === 'grading-check' ? await gradingCheck(reader, courseId, assignments, role)
      : await exportLatest(reader, courseId, assignments, options['--out'], options['--student-id-source'], options['--name-order']);
    console.log(JSON.stringify(command === 'grading-check' ? result : { destination: result.destination, ...result.summary }, null, 2));
    if (command === 'grading-check' && result.inconclusive) process.exitCode = 1;
  } finally { await context.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)); }
  catch (error) {
    const message = error instanceof z.ZodError ? 'Invalid input or unexpected Blackboard response schema' : error instanceof Error ? error.message : 'Workflow failed';
    console.error(message); process.exitCode = 1;
  }
}
