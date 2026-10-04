import { McpServer } from '@modelcontextprotocol/server';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { BlackboardService } from '../blackboard-service.js';
import { normalizeError } from '../errors.js';
import { idSchema } from '../schemas.js';

export const toolSchemas = {
  get_my_courses: z.strictObject({}),
  get_course: z.strictObject({ courseId: idSchema }),
  get_course_contents: z.strictObject({ courseId: idSchema, parentContentId: idSchema.optional() }),
  get_course_files: z.strictObject({ courseId: idSchema }),
  read_course_file: z.strictObject({ courseId: idSchema, contentId: idSchema, attachmentId: idSchema, offsetChars: z.number().int().min(0).default(0), maxChars: z.number().int().min(1000).max(100000).default(60000) }),
  get_assignments: z.strictObject({ courseId: idSchema }),
  get_assignment: z.strictObject({ courseId: idSchema, contentId: idSchema }),
  get_upcoming_deadlines: z.strictObject({ days: z.number().int().min(1).max(90).default(7), courseId: idSchema.optional() })
};

async function result(action: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const data = await action();
    // JSON round-trip makes the structured result a validated JSON object, without unsafe casts.
    const structuredContent = z.record(z.string(), z.json()).parse(JSON.parse(JSON.stringify({ data })));
    return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent };
  } catch (error) {
    const failure = error instanceof z.ZodError ? { code: 'InvalidInput', message: 'Input does not match the tool schema.' } : normalizeError(error);
    const structuredContent = { error: { code: failure.code, message: failure.message } };
    return { isError: true, content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent };
  }
}

export function registerTools(server: McpServer, service: BlackboardService): void {
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
  server.registerTool('get_my_courses', { description: 'List only your course memberships and course metadata.', inputSchema: toolSchemas.get_my_courses, annotations }, async () => result(() => service.getMyCourses()));
  server.registerTool('get_course', { description: 'Read basic metadata for a course in your membership scope.', inputSchema: toolSchemas.get_course, annotations }, async ({ courseId }) => result(() => service.getCourse(courseId)));
  server.registerTool('get_course_contents', { description: 'Read root contents or children of one content folder.', inputSchema: toolSchemas.get_course_contents, annotations }, async ({ courseId, parentContentId }) => result(() => service.getCourseContents(courseId, parentContentId)));
  server.registerTool('get_course_files', { description: 'List file attachments recursively under Original course folders.', inputSchema: toolSchemas.get_course_files, annotations }, async ({ courseId }) => result(() => service.getCourseFiles(courseId)));
  server.registerTool('read_course_file', { description: 'Extract PDF/DOCX text with character pagination; no OCR.', inputSchema: toolSchemas.read_course_file, annotations }, async ({ courseId, contentId, attachmentId, offsetChars, maxChars }) => result(() => service.readCourseFile(courseId, contentId, attachmentId, offsetChars, maxChars)));
  server.registerTool('get_assignments', { description: 'Read assignment instructions, possible scores and deadlines, without student grades.', inputSchema: toolSchemas.get_assignments, annotations }, async ({ courseId }) => result(() => service.getAssignments(courseId)));
  server.registerTool('get_assignment', { description: 'Read one Original course assignment and its grade column definition.', inputSchema: toolSchemas.get_assignment, annotations }, async ({ courseId, contentId }) => result(() => service.getAssignment(courseId, contentId)));
  server.registerTool('get_upcoming_deadlines', { description: 'Read upcoming assignment deadlines, sorted by UTC due date, from your available courses.', inputSchema: toolSchemas.get_upcoming_deadlines, annotations }, async ({ days, courseId }) => result(() => service.getUpcomingDeadlines(days, courseId)));
}
