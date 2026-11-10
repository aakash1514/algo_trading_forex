import { CredentialProvider } from 'minio/dist/main/CredentialProvider.js';
import { Credentials } from 'minio/dist/main/Credentials.js';

// Credentials for STORAGE=s3 from the EC2 instance's IAM role, through the instance metadata service
// (IMDSv2: a session token first, then the role's temporary credentials). Nothing is configured: no
// keys in the environment or on disk.
//
// Why not minio's own IamAwsProvider: in minio 8.0.7 (the latest release) its EC2/ECS path reads the
// field "AccessKeyID", while the metadata service answers "AccessKeyId" (AWS docs, "Retrieve security
// credentials from instance metadata"), so every request would be signed without an access key.
// ec2-role-credentials.spec.ts runs AWS's documented response through both.
//
// In a container the metadata service is one network hop further than on the host: the instance needs
// HttpPutResponseHopLimit = 2 (docs/DEPLOY.md), or the token request times out.
//
// Refresh: the credentials are reused until five minutes before their Expiration, then fetched again
// (getCredentials; concurrent callers share one fetch). The IMDSv2 session token asks for 6 hours
// (TOKEN_TTL_S) and is fetched anew with every credential fetch, so it never outlives its use.
// Secrets: nothing here logs, and no error carries a credential, the session token or a response
// body: errors name the request, the HTTP status or the response's Code only.

export const IMDS_ENDPOINT = 'http://169.254.169.254';
const TOKEN_TTL_S = 21_600;
const REFRESH_BEFORE_MS = 5 * 60_000; // AWS publishes new credentials at least five minutes before expiry
const REQUEST_TIMEOUT_MS = 2_000;

interface RoleCredentials {
  Code?: string;
  AccessKeyId?: string;
  SecretAccessKey?: string;
  Token?: string;
  Expiration?: string;
}

export class Ec2RoleCredentialProvider extends CredentialProvider {
  private current: { credentials: Credentials; expiresAtMs: number } | null = null;
  private inFlight: Promise<Credentials> | null = null;

  constructor(
    private readonly endpoint: string = IMDS_ENDPOINT,
    private readonly now: () => number = Date.now,
  ) {
    super({ accessKey: '', secretKey: '' });
  }

  override async getCredentials(): Promise<Credentials> {
    if (this.current && this.current.expiresAtMs - REFRESH_BEFORE_MS > this.now()) return this.current.credentials;
    this.inFlight ??= this.fetchCredentials().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async request(path: string, init: RequestInit): Promise<string> {
    const res = await fetch(new URL(path, this.endpoint), { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Instance metadata ${init.method ?? 'GET'} ${path}: HTTP ${res.status}`);
    return res.text();
  }

  private async fetchCredentials(): Promise<Credentials> {
    const token = await this.request('/latest/api/token', {
      method: 'PUT',
      headers: { 'X-aws-ec2-metadata-token-ttl-seconds': String(TOKEN_TTL_S) },
    });
    const headers = { 'X-aws-ec2-metadata-token': token };
    const roles = (await this.request('/latest/meta-data/iam/security-credentials/', { headers }))
      .split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
    if (roles.length === 0) throw new Error('No IAM role is attached to this instance');
    const text = await this.request(`/latest/meta-data/iam/security-credentials/${encodeURIComponent(roles[0])}`, { headers });
    let body: RoleCredentials;
    try {
      body = JSON.parse(text) as RoleCredentials;
    } catch {
      // never rethrow the parser's error: its message quotes the input, which holds the credentials
      throw new Error('Instance metadata returned credentials that are not JSON');
    }
    const expiresAtMs = Date.parse(body.Expiration ?? '');
    if (body.Code !== 'Success' || !body.AccessKeyId || !body.SecretAccessKey || !body.Token || !Number.isFinite(expiresAtMs)) {
      throw new Error(`Instance metadata returned no usable credentials (Code ${body.Code ?? 'missing'})`);
    }
    const credentials = new Credentials({ accessKey: body.AccessKeyId, secretKey: body.SecretAccessKey, sessionToken: body.Token });
    this.current = { credentials, expiresAtMs };
    return credentials;
  }
}
