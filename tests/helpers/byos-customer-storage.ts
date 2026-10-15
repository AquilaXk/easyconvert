import net from 'node:net';
import { Agent } from 'undici';
import { EMPTY_PAYLOAD_SHA256, UNSIGNED_PAYLOAD, signS3Request } from '../../src/lib/storage/s3-sigv4';
import { startS3StubServer, type S3StubServer } from './s3-stub-server';
import testCredentials from '../fixtures/sigv4/test-credentials.json';

/**
 * A customer's S3-compatible storage for BYOS graph tests: the independent SigV4 stub of
 * ./s3-stub-server plus the pieces a "customer" needs to sign requests for it. The agent connects
 * every request to the stub whatever host the URL names, so URL validation can run against a
 * public-looking host while the bytes go to a real local server.
 */
export const CUSTOMER_ORIGIN = 'http://files.example.org';
export const CUSTOMER_BUCKET = 'customer-bucket';
export const CUSTOMER_REGION = 'us-east-1';
export const CUSTOMER_ACCESS_KEY = testCredentials.roundtripStub.accessKeyId;
export const CUSTOMER_SECRET_KEY = testCredentials.roundtripStub.secretAccessKey;
export { EMPTY_PAYLOAD_SHA256, UNSIGNED_PAYLOAD };

export interface CustomerStorage {
  stub: S3StubServer;
  agent: Agent;
  close(): Promise<void>;
}

export async function startCustomerStorage(): Promise<CustomerStorage> {
  const stub = await startS3StubServer({
    bucket: CUSTOMER_BUCKET,
    credentials: { [CUSTOMER_ACCESS_KEY]: CUSTOMER_SECRET_KEY },
  });
  const port = Number(new URL(stub.url).port);
  const agent = new Agent({
    connect: ((_options: unknown, callback: (err: Error | null, socket?: net.Socket) => void) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => callback(null, socket));
      socket.once('error', (err) => callback(err));
    }) as never,
  });
  return {
    stub,
    agent,
    close: async () => {
      await agent.close();
      await stub.close();
    },
  };
}

export interface CustomerSignedRequest {
  url: string;
  /** Headers to hand to a graph node; Host is left out because the worker sends it from the URL. */
  headers: Record<string, string>;
  signature: string;
}

/** What the customer would produce for one request: a URL and SigV4 header authentication for it. */
export function signCustomerRequest(method: 'GET' | 'PUT', key: string, payloadHash: string): CustomerSignedRequest {
  const signed = signS3Request({
    method,
    origin: CUSTOMER_ORIGIN,
    path: `/${CUSTOMER_BUCKET}/${key}`,
    payloadHash,
    credentials: { accessKeyId: CUSTOMER_ACCESS_KEY, secretAccessKey: CUSTOMER_SECRET_KEY },
    region: CUSTOMER_REGION,
  });
  const { host: _host, ...headers } = signed.headers;
  return { url: signed.url, headers, signature: signed.signature };
}
