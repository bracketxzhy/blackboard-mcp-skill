import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createServer } from '../src/server.js';
import { toolSchemas } from '../src/tools/register.js';
import { coursePath, setup } from './helpers.js';

describe('MCP tools', () => {
  it('registers exactly 8 read-only tools and returns structured results over MCP', async () => {
    const { service, routes } = setup();
    routes.set(`${coursePath}/contents/_2005_1/attachments/_4001_1/download`, await readFile(new URL('./fixtures/text.pdf', import.meta.url)));
    const server = createServer(service);
    const client = new Client({ name: 'test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map(tool => tool.name).sort()).toEqual(Object.keys(toolSchemas).sort());
      expect(tools.tools.every(tool => tool.annotations?.readOnlyHint && !tool.annotations.destructiveHint)).toBe(true);
      const calls = [
        { name: 'get_my_courses', arguments: {} },
        { name: 'get_course', arguments: { courseId: '_1001_1' } },
        { name: 'get_course_contents', arguments: { courseId: '_1001_1' } },
        { name: 'get_course_files', arguments: { courseId: '_1001_1' } },
        { name: 'read_course_file', arguments: { courseId: '_1001_1', contentId: '_2005_1', attachmentId: '_4001_1' } },
        { name: 'get_assignments', arguments: { courseId: '_1001_1' } },
        { name: 'get_assignment', arguments: { courseId: '_1001_1', contentId: '_2006_1' } },
        { name: 'get_upcoming_deadlines', arguments: {} }
      ];
      for (const call of calls) {
        const value = await client.callTool(call);
        expect(value.isError).not.toBe(true);
        expect(value.structuredContent).toHaveProperty('data');
      }
      const denied = await client.callTool({ name: 'get_course', arguments: { courseId: '_999_1' } });
      expect(denied).toMatchObject({ isError: true, structuredContent: { error: { code: 'CourseAccessDenied' } } });
      const unsupported = await client.callTool({ name: 'read_course_file', arguments: { courseId: '_1001_1', contentId: '_2005_1', attachmentId: '_999_1' } });
      expect(unsupported).toMatchObject({ isError: true, structuredContent: { error: { code: 'BlackboardResourceNotFound' } } });
      expect(await client.callTool({ name: 'get_course', arguments: { courseId: '_1001_1', url: 'https://evil.example' } })).toMatchObject({ isError: true });
    } finally { await client.close(); await server.close(); }
  });
  it('strictly rejects extra parameters, URLs, invalid bounds and fractional inputs', () => {
    expect(toolSchemas.get_my_courses.safeParse({ foo: 1 }).success).toBe(false);
    for (const courseId of ['', ' ', '..', 'https://evil.example', '_1_1/../../users', '%2f']) expect(toolSchemas.get_course.safeParse({ courseId }).success).toBe(false);
    for (const days of [0, 91, 1.5, '7']) expect(toolSchemas.get_upcoming_deadlines.safeParse({ days }).success).toBe(false);
    const params = { courseId: '_1_1', contentId: '_2_1', attachmentId: '_3_1' };
    expect(toolSchemas.read_course_file.parse(params)).toMatchObject({ offsetChars: 0, maxChars: 60000 });
    for (const maxChars of [999, 100001, 1000.5]) expect(toolSchemas.read_course_file.safeParse({ ...params, maxChars }).success).toBe(false);
    for (const offsetChars of [-1, 0.5]) expect(toolSchemas.read_course_file.safeParse({ ...params, offsetChars }).success).toBe(false);
  });
});
