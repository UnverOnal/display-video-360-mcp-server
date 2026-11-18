import {
  GoogleApiError, classifyGoogleHttpError,
  type CommonGoogleApiErrorKind, type GoogleApiErrorDiagnostics, type GoogleErrorClassifier,
} from '../google/errors.js';

export type Dv360ErrorKind = CommonGoogleApiErrorKind;
export type Dv360ErrorDiagnostics = GoogleApiErrorDiagnostics;

const DEFAULT_MESSAGES: Record<Dv360ErrorKind, string> = {
  invalid_request: 'Google rejected the request.',
  unauthenticated: 'The Google login is no longer accepted. Run the Google login command again, then retry.',
  quota_project_denied: 'The Google account may not use the configured quota project. It needs the Service Usage Consumer role there.',
  api_disabled: 'The Display & Video 360 API is not enabled in the configured quota project, or the project ID is wrong.',
  scope_insufficient: 'The Google login lacks the Display & Video 360 scope. Run the Google login command again with the documented scopes.',
  daily_limit: 'The daily Display & Video 360 request quota is used up. Try again tomorrow.',
  rate_limited: 'Too many Display & Video 360 requests in the last minute. Wait a minute, then try again.',
  access_denied: 'Access denied. The partner or advertiser ID may be wrong, or the Google account this server uses has no access to it.',
  not_found: 'Not found, or not visible to the Google account this server uses.',
  server_error: 'Display & Video 360 had a temporary problem. Try again shortly.',
  timeout: 'Display & Video 360 did not respond in time. Try again shortly.',
  network: 'Could not reach Display & Video 360. Try again shortly.',
  unexpected_response: 'Display & Video 360 returned an unexpected response.',
};

export class Dv360Error extends GoogleApiError<Dv360ErrorKind> {
  constructor(kind: Dv360ErrorKind, message?: string, diagnostics?: Dv360ErrorDiagnostics) {
    super(kind, message ?? DEFAULT_MESSAGES[kind], diagnostics);
    this.name = 'Dv360Error';
  }
}

const CLASSIFIER: GoogleErrorClassifier<Dv360ErrorKind, Dv360Error> = {
  kindFor429: 'rate_limited',
  googleMessagePrefixes: { invalid_request: 'Google rejected the request' },
  create: (kind, message, diagnostics) => new Dv360Error(kind, message, diagnostics),
};

export function classifyHttpError(httpStatus: number, bodyText: string): Dv360Error {
  return classifyGoogleHttpError(httpStatus, bodyText, CLASSIFIER);
}
