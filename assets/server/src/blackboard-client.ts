import type { APIRequestContext, APIResponse } from 'playwright';
import { z } from 'zod';
import { BlackboardError, authenticationRequired } from './errors.js';
import { attachmentSchema, columnSchema, contentSchema, courseSchema, idSchema, membershipSchema } from './schemas.js';
import type { Attachment, Column, Content, Course, Membership } from './schemas.js';

// The transport capability deliberately contains only GET. No generic HTTP method exists.
export type ReadOnlyResponse = Pick<APIResponse<unknown>, 'status' | 'json' | 'body' | 'dispose'>;
export interface ReadOnlyRequest {
  get(url: string, options?: Parameters<APIRequestContext['get']>[1]): Promise<ReadOnlyResponse>;
}

class Limiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  async run<T>(action: () => Promise<T>): Promise<T> {
    if (this.active >= 4) await new Promise<void>(resolve => this.waiting.push(resolve));
    else this.active++;
    try { return await action(); }
    finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

export class BlackboardClient {
  private readonly limiter = new Limiter();
  private allowedCourseIds = new Set<string>();
  private memberships: Membership[] | undefined;
  private membershipTime = 0;
  private refresh: Promise<Membership[]> | undefined;
  private readonly courses = new Map<string, { time: number; value: Course }>();

  constructor(private readonly request: ReadOnlyRequest, private readonly baseUrl: string, private readonly clock: () => number = Date.now) {}

  private clearSession(): void {
    this.allowedCourseIds.clear();
    this.memberships = undefined;
    this.courses.clear();
  }

  private async get(url: string): Promise<ReadOnlyResponse> {
    return this.limiter.run(async () => {
      let response: ReadOnlyResponse;
      try { response = await this.request.get(url, { failOnStatusCode: false, maxRedirects: 10, timeout: 30000 }); }
      catch { throw new BlackboardError('BlackboardApiError', 'Blackboard GET failed or timed out.'); }
      const status = response.status();
      if (status >= 200 && status < 300) return response;
      await response.dispose();
      if (status === 401) { this.clearSession(); throw authenticationRequired(); }
      const code = status === 403 ? 'BlackboardPermissionDenied' : status === 404 ? 'BlackboardResourceNotFound' : 'BlackboardApiError';
      throw new BlackboardError(code, `Blackboard GET returned HTTP ${status}.`);
    });
  }

  private endpoint(path: string): string { return `${this.baseUrl}/learn/api/public/${path}`; }

  private async json<T>(url: string, schema: z.ZodType<T>): Promise<T> {
    const response = await this.get(url);
    try {
      const input: unknown = await response.json();
      const parsed = schema.safeParse(input);
      if (!parsed.success) {
        const fields = parsed.error.issues.slice(0, 5).map(issue => issue.path.join('.') || '(root)').join(', ');
        throw new BlackboardError('BlackboardProtocolError', `Blackboard JSON does not match the expected endpoint schema at: ${fields}.`);
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof BlackboardError) throw error;
      throw new BlackboardError('BlackboardProtocolError', 'Expected a Blackboard JSON response.');
    } finally { await response.dispose(); }
  }

  private async list<T>(path: string, itemSchema: z.ZodType<T>): Promise<T[]> {
    const schema = z.object({ results: z.array(itemSchema), paging: z.object({ nextPage: z.string().optional() }).optional() });
    const first = new URL(this.endpoint(path));
    let url: URL | undefined = first;
    const visited = new Set<string>();
    const results: T[] = [];
    while (url) {
      if (visited.has(url.href) || visited.size >= 1000) throw new BlackboardError('BlackboardProtocolError', 'Invalid or excessive API pagination.');
      visited.add(url.href);
      const page = await this.json(url.href, schema);
      results.push(...page.results);
      const next: string | undefined = page.paging?.nextPage;
      if (!next) { url = undefined; continue; }
      let candidate: URL;
      try { candidate = new URL(next, url); } catch { throw new BlackboardError('BlackboardProtocolError', 'Invalid pagination URL.'); }
      if (candidate.origin !== first.origin || candidate.pathname !== first.pathname || candidate.username || candidate.password || candidate.hash) {
        throw new BlackboardError('BlackboardProtocolError', 'Pagination must remain on the same predefined endpoint.');
      }
      url = candidate;
    }
    return results;
  }

  async getMemberships(force = false): Promise<Membership[]> {
    if (!force && this.memberships && this.clock() - this.membershipTime < 60000) return [...this.memberships];
    if (this.refresh) return this.refresh;
    this.refresh = (async () => {
      try {
        const values = await this.list('v1/users/me/courses', membershipSchema);
        this.allowedCourseIds = new Set(values.map(value => value.courseId));
        this.memberships = values;
        this.membershipTime = this.clock();
        this.courses.clear();
        return [...values];
      } catch (error) { this.clearSession(); throw error; }
    })();
    try { return await this.refresh; } finally { this.refresh = undefined; }
  }

  async assertCourseAccess(courseId: string): Promise<void> {
    idSchema.parse(courseId);
    await this.getMemberships();
    if (!this.allowedCourseIds.has(courseId)) throw new BlackboardError('CourseAccessDenied', 'Course is outside your current membership scope.');
  }

  private async coursePath(courseId: string): Promise<string> {
    await this.assertCourseAccess(courseId);
    return `v1/courses/${encodeURIComponent(courseId)}`;
  }

  async getCourse(courseId: string): Promise<Course> {
    const path = await this.coursePath(courseId);
    const cached = this.courses.get(courseId);
    if (cached && this.clock() - cached.time < 60000) return cached.value;
    const course = await this.json(this.endpoint(path), courseSchema);
    if (course.id !== courseId) throw new BlackboardError('BlackboardProtocolError', 'Course response identifier mismatch.');
    this.courses.set(courseId, { value: course, time: this.clock() });
    return course;
  }

  async getContents(courseId: string, parentContentId?: string): Promise<Content[]> {
    const path = await this.coursePath(courseId);
    const suffix = parentContentId === undefined ? 'contents' : `contents/${encodeURIComponent(idSchema.parse(parentContentId))}/children`;
    return this.list(`${path}/${suffix}`, contentSchema);
  }

  async getAttachments(courseId: string, contentId: string): Promise<Attachment[]> {
    const path = await this.coursePath(courseId);
    return this.list(`${path}/contents/${encodeURIComponent(idSchema.parse(contentId))}/attachments`, attachmentSchema);
  }

  async downloadAttachment(courseId: string, contentId: string, attachmentId: string): Promise<Buffer> {
    const path = await this.coursePath(courseId);
    const response = await this.get(this.endpoint(`${path}/contents/${encodeURIComponent(idSchema.parse(contentId))}/attachments/${encodeURIComponent(idSchema.parse(attachmentId))}/download`));
    try {
      const body = await response.body();
      if (body.length > 100 * 1024 * 1024) throw new BlackboardError('textExtractionUnavailable', 'File exceeds the 100 MiB extraction limit.');
      return body;
    } finally { await response.dispose(); }
  }

  async getGradeColumn(courseId: string, columnId: string): Promise<Column> {
    await this.assertCourseAccess(courseId);
    const column = await this.json(this.endpoint(`v2/courses/${encodeURIComponent(courseId)}/gradebook/columns/${encodeURIComponent(idSchema.parse(columnId))}`), columnSchema);
    if (column.id !== columnId) throw new BlackboardError('BlackboardProtocolError', 'Grade column response identifier mismatch.');
    return column;
  }
}
