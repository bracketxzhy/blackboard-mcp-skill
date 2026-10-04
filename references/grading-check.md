# Read-only grading capability check

```sh
node scripts/workflow.mjs grading-check --course _123_1
```

The command verifies current membership, discovers assignments, then for each grade column calls:

`GET /learn/api/public/v2/courses/{courseId}/gradebook/columns/{columnId}/attempts?fields=id,status&limit=1`

Do not pass `userId`: the documented exception allowing a student to read their own attempts would make the result unsuitable as a grading-permission check. The official public API requires `course.gradebook.MODIFY` to view attempts across the column. A successful response supports that entitlement; it does not prove that a particular grade-save request will succeed. If no assignment exists, report the check as inconclusive.

Return HTTP results, course role, assignment names and `actualGradeWriteVerified: false`. Do not fetch existing student scores, enter a score into a form, upload a CSV, save drafts, or invoke POST/PUT/PATCH/DELETE. An HTTP 401 is an authentication failure; HTTP 403 is permission denial. Neither should trigger retries against other students or another course.

Official documentation describes a real write endpoint:

`PATCH /learn/api/public/v2/courses/{courseId}/gradebook/columns/{columnId}/attempts/{attemptId}`

It needs `course.gradebook.MODIFY` for scores, text, feedback and publication. The column-user PATCH for overrides can directly mark scores `Posted`, so it is not a harmless way to test. The published API specification does not provide a documented dry-run parameter for grade updates. This package intentionally does not implement these writes.

Sources, checked 2026-10-04:

- [Blackboard developer portal Swagger UI](https://developer.blackboard.com/portal/displayApi)
- [Current official Learn Swagger](https://devportal-docstore.s3.amazonaws.com/learn-swagger.json)
- [Earlier official portal Swagger](https://developer.blackboard.com/portal/docs/apis/learn-swagger.json)

The documented public REST authentication is OAuth2 bearer. Cookie-authenticated requests work on the tested SCUPI deployment but are not promised by the API for every institution. A failing session-cookie request does not by itself establish the account's grading entitlement. Do not create an OAuth integration or weaken authentication as a hidden fallback.
