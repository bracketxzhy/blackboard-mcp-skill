import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { vi } from 'vitest';
import type { ReadOnlyRequest, ReadOnlyResponse } from '../src/blackboard-client.js';
import { BlackboardClient } from '../src/blackboard-client.js';
import { BlackboardService } from '../src/blackboard-service.js';

const input: unknown = JSON.parse(readFileSync(new URL('./fixtures/blackboard.json', import.meta.url), 'utf8'));
export const fixtures = z.record(z.string(), z.unknown()).parse(input);
export const baseUrl = 'https://pibb.scu.edu.cn';
export const coursePath = '/learn/api/public/v1/courses/_1001_1';
export const membershipPath = '/learn/api/public/v1/users/me/courses';

export function response(body: unknown, status = 200): ReadOnlyResponse {
  return { status: () => status, json: async () => body, body: async () => Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)), dispose: vi.fn(async () => {}) };
}

export function setup(clock: () => number = () => Date.parse('2026-10-04T00:00:00Z')): {
  routes: Map<string, unknown>; get: ReturnType<typeof vi.fn<ReadOnlyRequest['get']>>; client: BlackboardClient; service: BlackboardService;
} {
  const routes = new Map<string, unknown>([
    [membershipPath, fixtures['memberships']], [coursePath, fixtures['course']],
    [`${coursePath}/contents`, fixtures['root']],
    [`${coursePath}/contents/_2001_1/children`, fixtures['lectures']],
    [`${coursePath}/contents/_2002_1/children`, fixtures['homework']],
    [`${coursePath}/contents/_2003_1/children`, { results: [] }],
    [`${coursePath}/contents/_2004_1/children`, { results: [] }],
    [`${coursePath}/contents/_2005_1/attachments`, fixtures['attachments']],
    ['/learn/api/public/v2/courses/_1001_1/gradebook/columns/_3001_1', fixtures['hw1']],
    ['/learn/api/public/v2/courses/_1001_1/gradebook/columns/_3002_1', fixtures['hw2']]
  ]);
  const get = vi.fn<ReadOnlyRequest['get']>(async url => {
    const parsed = new URL(url);
    const key = parsed.pathname + parsed.search;
    if (!routes.has(key)) return response({}, 404);
    return response(routes.get(key));
  });
  const client = new BlackboardClient({ get }, baseUrl, clock);
  return { routes, get, client, service: new BlackboardService(client, clock) };
}
