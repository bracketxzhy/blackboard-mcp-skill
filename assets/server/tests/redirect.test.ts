import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { request } from 'playwright';
import { expect, it } from 'vitest';
import { BlackboardClient } from '../src/blackboard-client.js';

it('follows an actual fixture redirect with GET and the shared session cookie', async () => {
  const file = await readFile(new URL('./fixtures/text.pdf', import.meta.url));
  const calls: Array<{ method: string | undefined; url: string | undefined; cookie: string | undefined }> = [];
  const server = createServer((req, res) => {
    calls.push({ method: req.method, url: req.url, cookie: req.headers.cookie });
    if (req.url === '/learn/api/public/v1/users/me/courses') {
      res.setHeader('Set-Cookie', 'fixture_session=fixture-only; Path=/; HttpOnly');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ results: [{ courseId: '_1_1', courseRoleId: 'Student' }] }));
    } else if (req.url?.endsWith('/download')) {
      res.writeHead(302, { Location: '/fixture-file' });
      res.end();
    } else if (req.url === '/fixture-file') { res.end(file); }
    else { res.writeHead(404); res.end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected local fixture port');
  const context = await request.newContext();
  try {
    const client = new BlackboardClient(context, `http://127.0.0.1:${address.port}`);
    expect(await client.downloadAttachment('_1_1', '_2_1', '_3_1')).toEqual(file);
    expect(calls.every(call => call.method === 'GET')).toBe(true);
    expect(calls.find(call => call.url === '/fixture-file')?.cookie).toContain('fixture_session=fixture-only');
  } finally { await context.dispose(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
