import { createServer, IncomingMessage, Server } from 'http';
import type { AddressInfo } from 'net';
import { Client, IamAwsProvider } from 'minio';
import { Ec2RoleCredentialProvider } from './ec2-role-credentials';

// STORAGE=s3's credential path without AWS: a local stand-in for the EC2 instance metadata service
// (IMDSv2 rules: token by PUT, then requests carrying it) answering with the example response from
// AWS's documentation, verbatim, and a local stand-in for the S3 endpoint that records what the real
// minio client sends. No request leaves the machine.

// docs.aws.amazon.com/AWSEC2/latest/UserGuide/instance-metadata-security-credentials.html (example output)
const DOCUMENTED = {
  Code: 'Success',
  LastUpdated: '2012-04-26T16:39:16Z',
  Type: 'AWS-HMAC',
  AccessKeyId: 'ASIAIOSFODNN7EXAMPLE',
  SecretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  Token: 'token',
  Expiration: '2017-05-17T15:09:54Z',
};
const ROLE = 'forexedge-ec2';
const IMDS_TOKEN = 'imds-session-token';

const listen = (server: Server) =>
  new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

function fakeImds(credentials: object) {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    const url = (req.url ?? '').replace(/\/{2,}/g, '/'); // minio's provider asks for …credentials//<role>
    if (req.method === 'PUT' && url === '/latest/api/token' && req.headers['x-aws-ec2-metadata-token-ttl-seconds']) {
      return res.end(IMDS_TOKEN);
    }
    if (req.headers['x-aws-ec2-metadata-token'] !== IMDS_TOKEN) return res.writeHead(401).end();
    if (url === '/latest/meta-data/iam/security-credentials/') return res.end(`${ROLE}\n`);
    if (url === `/latest/meta-data/iam/security-credentials/${ROLE}`) return res.end(JSON.stringify(credentials));
    res.writeHead(404).end();
  });
  return { server, calls };
}

function fakeS3() {
  const received: IncomingMessage[] = [];
  const server = createServer((req, res) => {
    received.push(req);
    req.resume();
    req.on('end', () => res.writeHead(200, { ETag: '"0"' }).end());
  });
  return { server, received };
}

describe('Ec2RoleCredentialProvider (STORAGE=s3 credentials)', () => {
  const servers: Server[] = [];
  afterEach(async () => { await Promise.all(servers.splice(0).map(close)); });

  it('signs S3 requests with the role\'s credentials from the documented metadata response', async () => {
    const imds = fakeImds(DOCUMENTED);
    const s3 = fakeS3();
    servers.push(imds.server, s3.server);
    const imdsUrl = await listen(imds.server);
    const s3Port = Number(new URL(await listen(s3.server)).port);
    // the documented credentials expired in 2017: pin the clock before that so they are current
    const provider = new Ec2RoleCredentialProvider(imdsUrl, () => Date.parse('2017-05-17T15:00:00Z'));
    const client = new Client({ endPoint: '127.0.0.1', port: s3Port, useSSL: false, region: 'ap-south-1', credentialsProvider: provider });

    await client.putObject('forexedge-results', 'run-1/results.json', '{"trades":[]}', 13, { 'Content-Type': 'application/json' });

    expect(s3.received).toHaveLength(1);
    const req = s3.received[0];
    expect([req.method, req.url]).toEqual(['PUT', '/forexedge-results/run-1/results.json']);
    expect(req.headers['authorization']).toMatch(/^AWS4-HMAC-SHA256 Credential=ASIAIOSFODNN7EXAMPLE\/\d{8}\/ap-south-1\/s3\/aws4_request/);
    expect(req.headers['x-amz-security-token']).toBe('token');
    expect(imds.calls).toEqual([
      'PUT /latest/api/token',
      'GET /latest/meta-data/iam/security-credentials/',
      `GET /latest/meta-data/iam/security-credentials/${ROLE}`,
    ]);
  });

  it('control: minio\'s own IamAwsProvider reads AccessKeyID and gets no access key from the same response', async () => {
    const imds = fakeImds(DOCUMENTED);
    servers.push(imds.server);
    const credentials = await new IamAwsProvider({ customEndpoint: await listen(imds.server) }).getCredentials();
    expect(credentials.getAccessKey()).toBeUndefined();
    expect(credentials.getSessionToken()).toBe('token');
  });

  it('reuses the credentials until five minutes before they expire, then fetches new ones', async () => {
    const imds = fakeImds(DOCUMENTED);
    servers.push(imds.server);
    let now = Date.parse('2017-05-17T14:00:00Z');
    const provider = new Ec2RoleCredentialProvider(await listen(imds.server), () => now);
    await provider.getCredentials();
    await Promise.all([provider.getCredentials(), provider.getCredentials()]);
    expect(imds.calls).toHaveLength(3); // one fetch: token, role, credentials
    now = Date.parse('2017-05-17T15:05:00Z'); // 4 min 54 s before expiry
    await provider.getCredentials();
    expect(imds.calls).toHaveLength(6);
  });

  it.each([
    ['a failed credential response', { Code: 'AssumeRoleUnauthorizedAccess', Message: 'denied' }],
    ['a response without a session token', { ...DOCUMENTED, Token: undefined }],
  ])('refuses %s', async (_label, body) => {
    const imds = fakeImds(body);
    servers.push(imds.server);
    await expect(new Ec2RoleCredentialProvider(await listen(imds.server)).getCredentials())
      .rejects.toThrow('no usable credentials');
  });
});
