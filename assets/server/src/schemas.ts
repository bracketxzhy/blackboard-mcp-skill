import { z } from 'zod';

export const idSchema = z.string().trim().min(1).max(256).refine(value => !/[\s/\\?#%]/u.test(value) && value !== '.' && value !== '..', 'Must be an identifier, not a URL or path');
const timestamp = z.iso.datetime({ offset: true });
export const availabilitySchema = z.object({
  available: z.enum(['Yes', 'No', 'Disabled']).optional(),
  duration: z.object({ type: z.string().optional(), start: timestamp.optional(), end: timestamp.optional(), daysOfUse: z.number().optional() }).optional()
});
export const membershipSchema = z.object({ courseId: idSchema, courseRoleId: z.string().min(1), lastAccessed: timestamp.optional(), availability: availabilitySchema.optional() });
export const courseSchema = z.object({ id: idSchema, courseId: z.string(), name: z.string(), description: z.string().optional(), availability: availabilitySchema.optional(), ultraStatus: z.string().optional(), created: timestamp.optional(), modified: timestamp.optional() });
const fileSchema = z.object({ fileName: z.string(), mimeType: z.string().optional(), uploadId: z.string().optional() });
export const contentHandlerSchema = z.object({ id: z.string(), file: fileSchema.optional(), gradeColumnId: idSchema.optional() });
export const contentSchema = z.object({
  id: idSchema, parentId: idSchema.optional(), title: z.string(), body: z.string().optional(), created: timestamp.optional(), modified: timestamp.optional(), position: z.number().optional(), availability: availabilitySchema.optional(),
  contentHandler: contentHandlerSchema.optional(),
  hasChildren: z.boolean().optional()
});
export const attachmentSchema = z.object({ id: idSchema, fileName: z.string().min(1), mimeType: z.string().optional() });
export const columnSchema = z.object({ id: idSchema, name: z.string(), description: z.string().optional(), score: z.object({ possible: z.number() }).optional(), grading: z.object({ due: timestamp.optional(), attemptsAllowed: z.number().int().optional(), scoringModel: z.string().optional() }).optional(), availability: availabilitySchema.optional() });
export type Membership = z.infer<typeof membershipSchema>;
export type Course = z.infer<typeof courseSchema>;
export type Content = z.infer<typeof contentSchema>;
export type FileMetadata = z.infer<typeof fileSchema>;
export type Attachment = z.infer<typeof attachmentSchema>;
export type Column = z.infer<typeof columnSchema>;
