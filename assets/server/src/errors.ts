export type ErrorCode = 'AuthenticationRequired' | 'CourseAccessDenied' | 'BlackboardPermissionDenied' | 'BlackboardResourceNotFound' | 'BlackboardApiError' | 'BlackboardProtocolError' | 'NotAnAssignment' | 'textExtractionUnavailable' | 'UnsupportedFileType' | 'InvalidInput' | 'BrowserUnavailable';

export class BlackboardError extends Error {
  constructor(public readonly code: ErrorCode, message: string) {
    super(message);
    this.name = code;
  }
}

export function authenticationRequired(): BlackboardError {
  return new BlackboardError('AuthenticationRequired', 'Run: bb-mcp auth login');
}

export function normalizeError(error: unknown): BlackboardError {
  return error instanceof BlackboardError ? error : new BlackboardError('BlackboardApiError', 'Operation failed. No session or response data was logged.');
}
