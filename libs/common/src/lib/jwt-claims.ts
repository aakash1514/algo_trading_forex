// The claims every ForexEdge token carries and every verifier checks. auth-service signs; the REST
// guards, the socket gateways (handshake and replay reauth) and the Python services verify with
// exactly these values (research-agent and ml-service have the same constants in their auth.py, and
// a test there reads this file to keep them equal).
//
// Access and refresh tokens already use different secrets; their audiences differ too, so a refresh
// token is never accepted where an access token is expected, even if the two secrets were set equal.

export const JWT_ALGORITHM = 'HS256';
export const JWT_ISSUER = 'forexedge-auth';
export const JWT_ACCESS_AUDIENCE = 'forexedge-api';
export const JWT_REFRESH_AUDIENCE = 'forexedge-refresh';

// Options for jsonwebtoken's verify (JwtService.verify and passport-jwt take the same names)
export const ACCESS_TOKEN_VERIFY_OPTIONS = {
  algorithms: [JWT_ALGORITHM],
  issuer: JWT_ISSUER,
  audience: JWT_ACCESS_AUDIENCE,
} as const;

export const REFRESH_TOKEN_VERIFY_OPTIONS = {
  algorithms: [JWT_ALGORITHM],
  issuer: JWT_ISSUER,
  audience: JWT_REFRESH_AUDIENCE,
} as const;

export const ACCESS_TOKEN_SIGN_OPTIONS = {
  algorithm: JWT_ALGORITHM,
  issuer: JWT_ISSUER,
  audience: JWT_ACCESS_AUDIENCE,
} as const;

export const REFRESH_TOKEN_SIGN_OPTIONS = {
  algorithm: JWT_ALGORITHM,
  issuer: JWT_ISSUER,
  audience: JWT_REFRESH_AUDIENCE,
} as const;
