import {
  GoogleApiError, classifyGoogleHttpError,
  type GoogleApiErrorDiagnostics, type GoogleApiErrorKind, type GoogleErrorClassifier,
} from '../google/errors.js';

export type BidManagerErrorKind = GoogleApiErrorKind;
export type BidManagerErrorDiagnostics = GoogleApiErrorDiagnostics;

const DEFAULT_MESSAGES: Record<BidManagerErrorKind, string> = {
  invalid_request: 'Google rejected the request.',
  unauthenticated: 'The Google login is no longer accepted. Run the Google login command again, then retry.',
  quota_project_denied: 'The Google account may not use the configured quota project. It needs the Service Usage Consumer role there.',
  api_disabled: 'The Bid Manager API is not enabled in the configured quota project, or the project ID is wrong.',
  scope_insufficient: 'The Google login lacks the Bid Manager scope. Run the Google login command again with the documented scopes.',
  daily_limit: 'The daily Bid Manager request quota is used up. It resets at midnight Pacific time.',
  rate_limited: 'Too many Bid Manager requests right now. Wait a moment, then try again.',
  access_denied: 'Access denied; cause not yet identified.',
  not_found: 'Not found, or not created by the Google account this server uses.',
  resource_exhausted: 'Bid Manager quota exceeded.',
  server_error: 'Bid Manager had a temporary problem. Try again shortly.',
  timeout: 'Bid Manager did not respond in time. Try again shortly.',
  network: 'Could not reach Bid Manager. Try again shortly.',
  unexpected_response: 'Bid Manager returned an unexpected response.',
};

export class BidManagerError extends GoogleApiError<BidManagerErrorKind> {
  constructor(kind: BidManagerErrorKind, message?: string, diagnostics?: BidManagerErrorDiagnostics) {
    super(kind, message ?? DEFAULT_MESSAGES[kind], diagnostics);
    this.name = 'BidManagerError';
  }
}

const CLASSIFIER: GoogleErrorClassifier<BidManagerErrorKind, BidManagerError> = {
  kindFor429: 'resource_exhausted',
  googleMessagePrefixes: { invalid_request: 'Google rejected the request', resource_exhausted: 'Bid Manager quota exceeded' },
  create: (kind, message, diagnostics) => new BidManagerError(kind, message, diagnostics),
};

export function classifyHttpError(httpStatus: number, bodyText: string): BidManagerError {
  return classifyGoogleHttpError(httpStatus, bodyText, CLASSIFIER);
}
