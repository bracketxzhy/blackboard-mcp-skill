# Latest-submission export

After an explicit staff download request, discover the course with `node scripts/workflow.mjs courses` and use its internal ID:

```sh
node scripts/workflow.mjs export-latest --course _123_1 --out /absolute/path/to/new-output-directory
```

The output directory must not already exist. This avoids replacing user files or older exports without authorization. The command lists Original assignments and exports each student's latest submitted attempt per assignment. If an assignment title is `HW1` or `HW2`, that is the directory name. Single attachments sit directly inside that directory; multiple attachments use a personal subdirectory.

Filename/directory: `HW1-姓名-学号后四位`, followed by the original extension for a single file. Multi-file directories preserve original attachment names and disambiguate duplicate names. Never rename a JPEG into a PDF. This is one original-file export, not a format conversion.

## Identity and latest-attempt rules

Select only submitted statuses `NeedsGrading`, `Completed`, `NeedsGradingAgain`, `InProgressAgain`. Use `attemptDate`, then `created` to break equal submission-time ties. Missing/ambiguous dates fail explicitly. A later empty submission must not be replaced with an earlier file-bearing submission. Group attempts are not supported by this individual-student layout and cause an explicit error.

Fetch `id,name,studentId` only for people with selected submissions. Do not bulk-download a roster, contact details or grades. `studentId` must end in at least four numeric digits. Do not take the last four digits of a Blackboard internal user ID.

Some institutions use the login account as the student number and leave `studentId` empty. After the user or institution confirms that convention, explicitly select:

```sh
node scripts/workflow.mjs export-latest --course _123_1 --out /absolute/new-directory --student-id-source username
```

This reads `userName` for the required submitting users and records that source in the manifest. It is not a silent fallback. Name order can be chosen with `--name-order family-given` or `given-family`; default `auto` joins family+given for names containing Han characters and given+family for other names. If filenames collide after sanitization, stop rather than overwrite or invent an identity suffix.

## Official GET endpoints

- `/learn/api/public/v2/courses/{courseId}/gradebook/columns/{columnId}/attempts` with `fields=id,userId,groupAttemptId,status,attemptDate,created,studentSubmission`. No score fields.
- `/learn/api/public/v1/courses/{courseId}/gradebook/attempts/{attemptId}/files`
- The same path plus `/{fileId}/download`
- `/learn/api/public/v1/users/{userId}` with explicitly selected identity fields.

Before fetching students' attempt data, test the unfilted column-attempts GET using only `id,status` and `limit=1`. It requires course gradebook permission in the public API. Ensure the course remains in current membership scope.

Save original bytes, SHA-256 and byte counts. A corrupt upload is not a download failure if the original bytes are obtained correctly: preserve it and record a warning, particularly `.pdf` files without `%PDF-`. For text-only latest attempts, save the text as a named `.html` file; do not execute the HTML. Latest attempts without attachments or text remain in the manifest with no fake file. Report those cases and partial failures. The manifest can contain student names; treat the output as local student data, not material for GitHub.
