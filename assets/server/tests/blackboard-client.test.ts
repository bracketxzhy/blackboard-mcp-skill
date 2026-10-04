import { describe, expect, it, vi } from 'vitest';
import { BlackboardClient } from '../src/blackboard-client.js';
import { baseUrl, coursePath, fixtures, membershipPath, response, setup } from './helpers.js';

describe('BlackboardClient', () => {
  it.each([[401, 'AuthenticationRequired'], [403, 'BlackboardPermissionDenied'], [404, 'BlackboardResourceNotFound'], [500, 'BlackboardApiError']])('normalizes HTTP %s without leaking body', async (status, code) => {
    const client = new BlackboardClient({ get: async () => response({ secret: 'COOKIE' }, Number(status)) }, baseUrl);
    await expect(client.getMemberships()).rejects.toMatchObject({ code });
    await expect(client.getMemberships()).rejects.not.toHaveProperty('message', expect.stringContaining('COOKIE'));
  });
  it('parses current membership, strips private fields and resolves course metadata', async () => {
    const { client } = setup();
    expect(await client.getMemberships()).toEqual([{ courseId: '_1001_1', courseRoleId: 'TeachingAssistant', lastAccessed: '2026-10-04T01:00:00.000Z' }]);
    expect(await client.getCourse('_1001_1')).toMatchObject({ name: 'Example Physics Course', ultraStatus: 'Classic' });
    expect(await client.getCourse('_1001_1')).not.toHaveProperty('uuid');
  });
  it('denies every course endpoint outside membership before requesting it', async () => {
    const { client, get } = setup();
    const calls = [() => client.getCourse('_999_1'), () => client.getContents('_999_1'), () => client.getAttachments('_999_1', '_1_1'), () => client.downloadAttachment('_999_1', '_1_1', '_2_1'), () => client.getGradeColumn('_999_1', '_3_1')];
    for (const call of calls) await expect(call()).rejects.toMatchObject({ code: 'CourseAccessDenied' });
    expect(get.mock.calls.every(([url]) => new URL(url).pathname === membershipPath)).toBe(true);
  });
  it('rejects invalid JSON shapes and identifiers', async () => {
    const { client, routes } = setup();
    routes.set(membershipPath, { results: [{}] });
    await expect(client.getMemberships()).rejects.toMatchObject({ code: 'BlackboardProtocolError' });
    await expect(client.getContents('../users')).rejects.toThrow();
    await expect(client.getMemberships()).rejects.toMatchObject({ code: 'BlackboardProtocolError' });
  });
  it('paginates memberships and contents only on the same predefined endpoint', async () => {
    const { client, routes } = setup();
    routes.set(membershipPath, { results: [], paging: { nextPage: `${membershipPath}?offset=1` } });
    routes.set(`${membershipPath}?offset=1`, fixtures['memberships']);
    expect(await client.getMemberships()).toHaveLength(1);
    routes.set(`${coursePath}/contents`, { results: [], paging: { nextPage: `${coursePath}/contents?offset=1` } });
    routes.set(`${coursePath}/contents?offset=1`, fixtures['root']);
    expect(await client.getContents('_1001_1')).toHaveLength(4);
  });
  it.each(['https://evil.example/steal', '/learn/api/public/v1/courses', `${membershipPath}?loop=1`])('blocks pagination redirects or cycles: %s', async next => {
    const { client, routes } = setup();
    const page = { results: [], paging: { nextPage: next } };
    routes.set(membershipPath, page);
    routes.set(`${membershipPath}?loop=1`, page);
    await expect(client.getMemberships()).rejects.toMatchObject({ code: 'BlackboardProtocolError' });
  });
  it('refreshes membership after 60 seconds and revokes cached course access', async () => {
    let now = 0;
    const { client, routes } = setup(() => now);
    await client.getCourse('_1001_1');
    routes.set(membershipPath, { results: [] });
    now = 60001;
    await expect(client.getCourse('_1001_1')).rejects.toMatchObject({ code: 'CourseAccessDenied' });
  });
  it('shares one membership refresh and enforces max concurrency 4 globally', async () => {
    const { client, get } = setup();
    await Promise.all(Array.from({ length: 10 }, () => client.getMemberships()));
    expect(get).toHaveBeenCalledTimes(1);
    let active = 0;
    let maximum = 0;
    get.mockImplementation(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise<void>(resolve => setTimeout(resolve, 5));
      active--;
      return response({ results: [] });
    });
    await Promise.all(Array.from({ length: 20 }, () => client.getContents('_1001_1')));
    expect(maximum).toBe(4);
  });
  it('uses GET only and asks Playwright to follow redirects', async () => {
    const { client, get, routes } = setup();
    routes.set(`${coursePath}/contents/_2005_1/attachments/_4001_1/download`, Buffer.from('file'));
    expect(await client.downloadAttachment('_1001_1', '_2005_1', '_4001_1')).toEqual(Buffer.from('file'));
    expect(get).toHaveBeenLastCalledWith(expect.stringContaining('/download'), expect.objectContaining({ maxRedirects: 10 }));
    for (const method of ['post', 'put', 'patch', 'delete', 'POST', 'PUT', 'PATCH', 'DELETE', 'fetch']) expect(method in client).toBe(false);
  });
  it('clears membership immediately on authentication failure', async () => {
    const { client, get } = setup();
    await client.getMemberships();
    get.mockResolvedValue(response({}, 401));
    await expect(client.getContents('_1001_1')).rejects.toMatchObject({ code: 'AuthenticationRequired' });
    get.mockClear();
    await expect(client.getCourse('_1001_1')).rejects.toMatchObject({ code: 'AuthenticationRequired' });
    expect(get).toHaveBeenCalledWith(baseUrl + membershipPath, expect.anything());
  });
});
