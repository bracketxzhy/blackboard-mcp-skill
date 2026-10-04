import { z } from 'zod';
import { BlackboardClient } from './blackboard-client.js';
import { BlackboardError } from './errors.js';
import type { Attachment, Content, Course, FileMetadata } from './schemas.js';
import { extractPdf } from './extractors/pdf.js';
import { extractDocx } from './extractors/docx.js';

type Availability = Course['availability'];
export interface MyCourse {
  internalCourseId: string; externalCourseId: string | null; name: string | null; role: string;
  availability: Availability | null; ultraStatus: string | null; lastAccessed: string | null;
  metadataError?: { code: 'BlackboardPermissionDenied' | 'BlackboardResourceNotFound'; message: string };
}
export interface CourseFile {
  contentId: string; title: string; fileName: string; mimeType: string | null; attachmentId: string;
  created: string | null; modified: string | null; parentPath: string;
}
export interface FileText {
  fileName: string; mimeType: string; text: string; offsetChars: number; returnedChars: number; totalChars: number; hasMore: boolean;
}
export interface Assignment {
  contentId: string; gradeColumnId: string; name: string; title: string; description: string | null; body: string | null;
  possibleScore: number | null; dueUtc: string | null; dueLocal: string | null; timezone: 'Asia/Shanghai';
  attemptsAllowed: number | null; scoringModel: string | null; availability: Content['availability'] | null;
}
export interface Deadline {
  courseId: string; courseName: string; assignmentName: string; possibleScore: number | null;
  dueUtc: string; dueLocal: string; attemptsAllowed: number | null; scoringModel: string | null;
}
interface TreeEntry { content: Content; path: string; }

export async function mapLimited<T, R>(values: readonly T[], fn: (value: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let offset = 0; offset < values.length; offset += 4) results.push(...await Promise.all(values.slice(offset, offset + 4).map(fn)));
  return results;
}

export function localDue(utc: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(utc));
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find(value => value.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
}

export class BlackboardService {
  constructor(private readonly client: BlackboardClient, private readonly clock: () => number = Date.now) {}

  async getMyCourses(): Promise<MyCourse[]> {
    const memberships = await this.client.getMemberships();
    return mapLimited(memberships, async membership => {
      try {
        const course = await this.client.getCourse(membership.courseId);
        return { internalCourseId: membership.courseId, externalCourseId: course.courseId, name: course.name, role: membership.courseRoleId, availability: course.availability ?? null, ultraStatus: course.ultraStatus ?? null, lastAccessed: membership.lastAccessed ?? null };
      } catch (error) {
        if (!(error instanceof BlackboardError) || (error.code !== 'BlackboardPermissionDenied' && error.code !== 'BlackboardResourceNotFound')) throw error;
        // A historical membership remains real even when the server denies its course metadata.
        // Preserve it with an explicit error; never drop it or invent a course name/availability.
        const course: MyCourse = { internalCourseId: membership.courseId, externalCourseId: null, name: null, role: membership.courseRoleId, availability: null, ultraStatus: null, lastAccessed: membership.lastAccessed ?? null, metadataError: { code: error.code, message: error.message } };
        return course;
      }
    });
  }

  async getCourse(courseId: string): Promise<Course> { return this.client.getCourse(courseId); }

  async getCourseContents(courseId: string, parentContentId?: string): Promise<Array<Content & { gradeColumnId: string | null; file: FileMetadata | null }>> {
    return (await this.client.getContents(courseId, parentContentId)).map(content => ({ ...content, gradeColumnId: content.contentHandler?.gradeColumnId ?? null, file: content.contentHandler?.file ?? null }));
  }

  private async tree(courseId: string, foldersOnly: boolean): Promise<TreeEntry[]> {
    await this.client.assertCourseAccess(courseId);
    const visited = new Set<string>();
    const output: TreeEntry[] = [];
    const pending: Array<{ parent: string | undefined; path: string }> = [{ parent: undefined, path: '' }];
    while (pending.length > 0) {
      const batch = pending.splice(0, 4);
      const children = await mapLimited(batch, async node => ({ node, contents: await this.client.getContents(courseId, node.parent) }));
      for (const { node, contents } of children) {
        for (const content of contents) {
          if (visited.has(content.id)) continue;
          visited.add(content.id);
          if (visited.size > 20000) throw new BlackboardError('BlackboardProtocolError', 'Course content tree exceeds the traversal limit.');
          const path = node.path ? `${node.path} / ${content.title}` : content.title;
          output.push({ content, path });
          const isFolder = content.contentHandler?.id === 'resource/x-bb-folder';
          if (isFolder || (!foldersOnly && content.hasChildren === true)) pending.push({ parent: content.id, path });
        }
      }
    }
    return output;
  }

  async getCourseFiles(courseId: string): Promise<CourseFile[]> {
    const entries = (await this.tree(courseId, true)).filter(entry => entry.content.contentHandler?.id === 'resource/x-bb-file');
    const files = await mapLimited(entries, async ({ content, path }) => (await this.client.getAttachments(courseId, content.id)).map(attachment => ({ contentId: content.id, title: content.title, fileName: attachment.fileName, mimeType: attachment.mimeType ?? content.contentHandler?.file?.mimeType ?? null, attachmentId: attachment.id, created: content.created ?? null, modified: content.modified ?? null, parentPath: path })));
    return files.flat();
  }

  async readCourseFile(courseId: string, contentId: string, attachmentId: string, offsetChars = 0, maxChars = 60000): Promise<FileText> {
    z.number().int().min(0).parse(offsetChars);
    z.number().int().min(1000).max(100000).parse(maxChars);
    const attachments = await this.client.getAttachments(courseId, contentId);
    const attachment: Attachment | undefined = attachments.find(value => value.id === attachmentId);
    if (!attachment) throw new BlackboardError('BlackboardResourceNotFound', 'Attachment is not associated with this content.');
    const mime = attachment.mimeType?.split(';')[0]?.trim().toLowerCase();
    const pdf = mime === 'application/pdf';
    const docx = mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || (mime === undefined && attachment.fileName.toLowerCase().endsWith('.docx'));
    if (!pdf && !docx) throw new BlackboardError('UnsupportedFileType', 'Only PDF and DOCX text extraction is supported.');
    const buffer = await this.client.downloadAttachment(courseId, contentId, attachmentId);
    let fullText: string;
    try { fullText = pdf ? await extractPdf(buffer) : await extractDocx(buffer); }
    catch { throw new BlackboardError('textExtractionUnavailable', 'File could not be parsed as readable PDF/DOCX text.'); }
    if (!fullText.trim()) throw new BlackboardError('textExtractionUnavailable', 'File has no extractable text. OCR is not supported.');
    const text = fullText.slice(offsetChars, offsetChars + maxChars);
    return { fileName: attachment.fileName, mimeType: pdf ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', text, offsetChars, returnedChars: text.length, totalChars: fullText.length, hasMore: offsetChars + text.length < fullText.length };
  }

  private async assignment(courseId: string, content: Content): Promise<Assignment> {
    if (content.contentHandler?.id !== 'resource/x-bb-assignment') throw new BlackboardError('NotAnAssignment', 'Requested content is not an Original course assignment.');
    const gradeColumnId = content.contentHandler.gradeColumnId;
    if (!gradeColumnId) throw new BlackboardError('BlackboardProtocolError', 'Assignment has no gradeColumnId.');
    const column = await this.client.getGradeColumn(courseId, gradeColumnId);
    const dueUtc = column.grading?.due ?? null;
    return { contentId: content.id, gradeColumnId, name: column.name, title: content.title, description: column.description ?? content.body ?? null, body: content.body ?? null, possibleScore: column.score?.possible ?? null, dueUtc, dueLocal: dueUtc ? localDue(dueUtc) : null, timezone: 'Asia/Shanghai', attemptsAllowed: column.grading?.attemptsAllowed ?? null, scoringModel: column.grading?.scoringModel ?? null, availability: content.availability ?? column.availability ?? null };
  }

  async getAssignments(courseId: string): Promise<Assignment[]> {
    const entries = (await this.tree(courseId, false)).filter(entry => entry.content.contentHandler?.id === 'resource/x-bb-assignment');
    return mapLimited(entries, entry => this.assignment(courseId, entry.content));
  }

  async getAssignment(courseId: string, contentId: string): Promise<Assignment> {
    const entry = (await this.tree(courseId, false)).find(value => value.content.id === contentId);
    if (!entry) throw new BlackboardError('BlackboardResourceNotFound', 'Content was not found in the course tree.');
    return this.assignment(courseId, entry.content);
  }

  async getUpcomingDeadlines(days = 7, courseId?: string): Promise<Deadline[]> {
    z.number().int().min(1).max(90).parse(days);
    const now = this.clock();
    const end = now + days * 86400000;
    const courses = courseId === undefined
      ? (await this.getMyCourses()).flatMap(course => course.availability?.available === 'Yes' && course.name !== null ? [{ id: course.internalCourseId, name: course.name }] : [])
      : [await this.client.getCourse(courseId)];
    const lists = await mapLimited(courses, async course => {
      const assignments = await this.getAssignments(course.id);
      const values: Deadline[] = [];
      for (const assignment of assignments) {
        if (!assignment.dueUtc || !assignment.dueLocal) continue;
        const due = Date.parse(assignment.dueUtc);
        if (due < now || due > end) continue;
        values.push({ courseId: course.id, courseName: course.name, assignmentName: assignment.title, possibleScore: assignment.possibleScore, dueUtc: assignment.dueUtc, dueLocal: assignment.dueLocal, attemptsAllowed: assignment.attemptsAllowed, scoringModel: assignment.scoringModel });
      }
      return values;
    });
    return lists.flat().sort((a, b) => Date.parse(a.dueUtc) - Date.parse(b.dueUtc));
  }
}
