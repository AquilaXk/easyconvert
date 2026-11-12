import { describe, expect, it } from 'vitest';
import { validateJobGraph, type JobGraph } from '../src/lib/jobs/graph';
import { checkSubmissionLimits } from '../src/lib/jobs/submission-limits';
import { missingStorageCredentials } from '../src/lib/jobs/storage-credential-check';
import { remotePathProblem } from '../src/lib/storage/customer-storage-paths';
import { credentialsVault } from '../src/lib/storage/credentials-vault';
import { graphNodeJobId, sealGraph } from '../src/lib/queue/graph/node-jobs';
import { openStorageNodeCredentials, sealGraphNode } from '../src/lib/queue/graph/sealed-nodes';
import { redactForOutput } from '../src/lib/security/redact';
import { SecretSealError, unsealJobSecret } from '../src/lib/security/job-secret-seal';
import { resolveNodeResourceClass } from '../src/lib/queue/resource-class';
import { graphNodeCharge, graphNodeReservedUnits } from '../src/lib/jobs/graph-operations';

/**
 * What a graph with customer-storage nodes must state to be accepted, and what happens to the credentials it carries:
 * sealed with the node at submission, never in the node as stored or shown.
 */

const S3 = { bucket: 'customer-bucket', accessKeyId: 'AKIAEXAMPLEKEY000001', secretAccessKey: 'secret/EXAMPLE+value0000000000000000', endpoint: 'https://objects.example.org' };
const SFTP = { host: 'sftp.example.org', username: 'deploy', privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n' };
const REF = `cred_${'a'.repeat(32)}`;

function graph(inNode: Record<string, unknown>, outNode: Record<string, unknown> = { op: 'export.s3', credentialRef: REF }): JobGraph {
  return {
    nodes: {
      in: inNode,
      conv: { op: 'convert', input: 'in', targetFormat: 'json' },
      out: { input: 'conv', ...outNode },
    },
  } as unknown as JobGraph;
}

function problems(inNode: Record<string, unknown>, outNode?: Record<string, unknown>): Array<[string, string]> {
  return validateJobGraph(graph(inNode, outNode)).errors.map((e) => [e.code, e.path]);
}

describe('storage nodes in a graph', () => {
  it('accepts a saved credential or inline credentials, and a key or a prefix', () => {
    expect(problems({ op: 'import.s3', credentialRef: REF, key: 'in/people.csv' })).toEqual([]);
    expect(problems({ op: 'import.s3', credentials: S3, prefix: 'in/', maxObjects: 50 }, { op: 'export.sftp', credentials: SFTP, directory: 'out' })).toEqual([]);
    expect(problems({ op: 'import.sftp', credentialRef: REF, directory: 'reports' }, { op: 'export.s3', credentialRef: REF })).toEqual([]);
    expect(problems({ op: 'import.sftp', credentialRef: REF, path: 'reports/q3.csv' }, { op: 'export.sftp', credentialRef: REF })).toEqual([]);
  });

  it('infers the format of a single file from its key, and leaves a prefix to run time', () => {
    const single = validateJobGraph(graph({ op: 'import.s3', credentialRef: REF, key: 'in/people.csv' }));
    const listed = validateJobGraph(graph({ op: 'import.s3', credentialRef: REF, prefix: 'in/' }));
    expect(single.inferredOutputFormats?.in).toBe('csv');
    expect(listed.inferredOutputFormats?.in).toBe('dynamic');
  });

  it.each([
    ['neither a reference nor credentials', { op: 'import.s3', key: 'a.csv' }, ['MISSING_STORAGE_CREDENTIALS']],
    ['a reference and credentials', { op: 'import.s3', credentialRef: REF, credentials: S3, key: 'a.csv' }, ['CONFLICTING_STORAGE_CREDENTIALS']],
    ['a reference that is not one', { op: 'import.s3', credentialRef: 'cred_nope', key: 'a.csv' }, ['INVALID_CREDENTIAL_REF']],
    ['a credential field it does not take', { op: 'import.s3', credentials: { ...S3, host: 'x' }, key: 'a.csv' }, ['INVALID_STORAGE_CREDENTIALS']],
    ['a credential field of the wrong type', { op: 'import.s3', credentials: { ...S3, forcePathStyle: 'yes' }, key: 'a.csv' }, ['INVALID_STORAGE_CREDENTIALS']],
    ['S3 credentials without a secret', { op: 'import.s3', credentials: { bucket: 'customer-bucket', accessKeyId: 'a' }, key: 'a.csv' }, ['INVALID_STORAGE_CREDENTIALS']],
    ['SFTP credentials with only a password', { op: 'import.sftp', credentials: { host: 'sftp.example.org', username: 'u', password: 'p' }, path: 'a.csv' }, ['INVALID_STORAGE_CREDENTIALS']],
    ['both a key and a prefix', { op: 'import.s3', credentialRef: REF, key: 'a.csv', prefix: 'in/' }, ['CONFLICTING_STORAGE_PATH']],
    ['neither a key nor a prefix', { op: 'import.s3', credentialRef: REF }, ['MISSING_STORAGE_PATH']],
    ['neither a path nor a directory', { op: 'import.sftp', credentialRef: REF }, ['MISSING_STORAGE_PATH']],
    ['maxObjects on a single file', { op: 'import.s3', credentialRef: REF, key: 'a.csv', maxObjects: 3 }, ['INVALID_MAX_OBJECTS']],
    ['maxObjects of 0', { op: 'import.s3', credentialRef: REF, prefix: 'in/', maxObjects: 0 }, ['INVALID_MAX_OBJECTS']],
    ['maxObjects over the most', { op: 'import.s3', credentialRef: REF, prefix: 'in/', maxObjects: 101 }, ['INVALID_MAX_OBJECTS']],
  ])('refuses %s', (_label, node, codes) => {
    expect(problems(node as Record<string, unknown>).map(([code]) => code)).toEqual(codes);
  });

  it.each([
    ['https://169.254.169.254', 'the metadata address'],
    ['https://127.0.0.1:9000', 'a loopback address'],
    ['https://10.0.0.8', 'a private address'],
    ['http://objects.example.org', 'plain http'],
  ])('refuses the S3 endpoint %s (%s) at submission', (endpoint) => {
    expect(problems({ op: 'import.s3', credentials: { ...S3, endpoint }, key: 'a.csv' }).map(([code]) => code)).toEqual(['INVALID_STORAGE_CREDENTIALS']);
  });

  it.each(['10.0.0.8', '127.0.0.1', '169.254.169.254', 'localhost', '192.168.1.5', '[::1]'])('refuses the SFTP host %s at submission', (host) => {
    expect(problems({ op: 'import.sftp', credentials: { ...SFTP, host }, path: 'a.csv' }).map(([code]) => code)).toEqual(['INVALID_STORAGE_CREDENTIALS']);
  });

  it('does not echo a secret in the refusal of a credential', () => {
    const errors = validateJobGraph(graph({ op: 'import.s3', credentials: { ...S3, endpoint: 'https://user:hunter2@10.0.0.9/?sig=abc123' }, key: 'a.csv' })).errors;
    expect(JSON.stringify(errors)).not.toMatch(/hunter2|abc123|secret\/EXAMPLE/);
  });
});

describe('the names a node gives in the customer store', () => {
  it.each([
    ['../etc/passwd', 'a ".." segment'],
    ['a/../b', 'a ".." segment'],
    ['a/./b', 'a "." segment'],
    ['/abs/key', 'a leading slash'],
    ['a\\b', 'a backslash'],
    ['a\nb', 'a line break'],
    ['a\u0000b', 'a NUL byte'],
    ['x'.repeat(1025), 'more than 1024 bytes'],
    ['é'.repeat(513), 'more than 1024 bytes of UTF-8'],
    ['', 'an empty key'],
  ])('refuses %s (%s)', (name) => {
    expect(remotePathProblem(name)).toBeTypeOf('string');
  });

  it('accepts ordinary keys, an empty prefix, and names that only look like paths', () => {
    expect(remotePathProblem('reports/2026/q3 final.csv')).toBeUndefined();
    expect(remotePathProblem('..hidden/file')).toBeUndefined();
    expect(remotePathProblem('a//b')).toBeUndefined();
    expect(remotePathProblem('', { allowEmpty: true })).toBeUndefined();
  });

  it('refuses them in an export prefix and directory too', () => {
    expect(problems({ op: 'import.s3', credentialRef: REF, key: 'a.csv' }, { op: 'export.s3', credentialRef: REF, prefix: '../out/' }).map(([code]) => code)).toEqual(['INVALID_STORAGE_PATH']);
    expect(problems({ op: 'import.s3', credentialRef: REF, key: 'a.csv' }, { op: 'export.sftp', credentialRef: REF, directory: '/etc' }).map(([code]) => code)).toEqual(['INVALID_STORAGE_PATH']);
  });
});

describe('storage nodes in the graph machinery', () => {
  it('charges nothing for a node that only moves files, and runs in the light lane', () => {
    for (const op of ['import.s3', 'import.sftp', 'export.s3', 'export.sftp']) {
      expect(graphNodeCharge(op, { outputs: 3, optimizations: [] })).toBe(0);
      expect(graphNodeReservedUnits({ op, input: 'x' })).toBe(0);
      expect(resolveNodeResourceClass({ op })).toBe('light');
    }
  });

  it('needs an import and an export node, which a storage node is', () => {
    expect(validateJobGraph({ nodes: { conv: { op: 'convert', input: 'x', targetFormat: 'json' } } } as unknown as JobGraph).errors.map((e) => e.code)).toContain('MISSING_IMPORT_NODE');
    expect(problems({ op: 'import.s3', credentialRef: REF, key: 'a.csv' })).toEqual([]);
  });

  it('cannot use an export to a store as the input of another node', () => {
    const errors = validateJobGraph({
      nodes: { in: { op: 'import.s3', credentialRef: REF, key: 'a.csv' }, out: { op: 'export.sftp', credentialRef: REF, input: 'in' }, conv: { op: 'convert', input: 'out', targetFormat: 'json' } },
    } as unknown as JobGraph).errors;
    expect(errors.map((e) => [e.code, e.path])).toEqual([['EXPORT_USED_AS_INPUT', 'nodes.conv.input']]);
  });
});

describe('saved credentials at submission', () => {
  it('names only the nodes whose credential the owner cannot use', async () => {
    const mine = await credentialsVault.store('user_validation_owner', { type: 's3', ...S3 });
    const theirs = await credentialsVault.store('user_validation_other', { type: 's3', ...S3 });
    const normalized = {
      in: { id: 'in', op: 'import.s3', credentialRef: mine, key: 'a.csv' },
      out: { id: 'out', op: 'export.s3', credentialRef: theirs },
      wrongKind: { id: 'wrongKind', op: 'export.sftp', credentialRef: mine },
      unknown: { id: 'unknown', op: 'export.s3', credentialRef: `cred_${'0'.repeat(32)}` },
      inline: { id: 'inline', op: 'export.s3', credentials: S3 },
    };
    const missing = await missingStorageCredentials(normalized, 'user_validation_owner');

    expect(missing.map((p) => [p.code, p.path])).toEqual([
      ['STORAGE_CREDENTIAL_NOT_FOUND', 'nodes.out.credentialRef'],
      ['STORAGE_CREDENTIAL_NOT_FOUND', 'nodes.wrongKind.credentialRef'],
      ['STORAGE_CREDENTIAL_NOT_FOUND', 'nodes.unknown.credentialRef'],
    ]);
    expect(JSON.stringify(missing)).not.toContain(theirs);
    await credentialsVault.delete(mine, 'user_validation_owner');
    await credentialsVault.delete(theirs, 'user_validation_other');
  });
});

describe('inline credentials are sealed with the node', () => {
  const SECRETS = [S3.secretAccessKey, S3.accessKeyId, SFTP.privateKey.split('\n')[1]];

  function sealedGraph() {
    return sealGraph('graph_seal', { nodes: { in: { op: 'import.s3', credentials: S3, key: 'a.csv' }, out: { op: 'export.sftp', input: 'in', credentials: SFTP, directory: 'out' } } } as never);
  }

  it('replaces the credentials by one blob and leaves the saved reference and the names as they are', () => {
    const sealed = sealedGraph();
    const text = JSON.stringify(sealed);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    expect(sealed.nodes.in).toMatchObject({ op: 'import.s3', key: 'a.csv', sealed: expect.stringMatching(/^sealed:v1:/) });
    expect(sealed.nodes.in).not.toHaveProperty('credentials');

    const withRef = sealGraphNode({ op: 'import.s3', credentialRef: REF, key: 'a.csv' }, 'job');
    expect(withRef).toEqual({ op: 'import.s3', credentialRef: REF, key: 'a.csv' });
  });

  it('opens only in the job it was sealed for, and refuses a node that still carries them', () => {
    const sealed = sealedGraph();
    const opened = openStorageNodeCredentials(sealed.nodes.in, graphNodeJobId('graph_seal', 'in'));
    expect(opened).toEqual(S3);
    expect(() => openStorageNodeCredentials(sealed.nodes.in, graphNodeJobId('graph_seal', 'out'))).toThrow(SecretSealError);
    expect(() => unsealJobSecret((sealed.nodes.out as unknown as { sealed: string }).sealed, graphNodeJobId('graph_seal', 'in'))).toThrow(SecretSealError);
    expect(() => openStorageNodeCredentials({ op: 'import.s3', credentials: S3 }, 'job')).toThrow(/not sealed/);
    expect(openStorageNodeCredentials({ op: 'import.s3', credentialRef: REF, key: 'a' }, 'job')).toBeUndefined();
  });

  it('masks credentials and the sealed blob in every view of a node', () => {
    const shown = JSON.stringify(redactForOutput({ nodes: { a: { op: 'import.s3', credentials: S3, key: 'a.csv' }, b: sealedGraph().nodes.in } }));
    for (const secret of SECRETS) expect(shown).not.toContain(secret);
    expect(shown).not.toContain('sealed:v1:');
  });

  it('refuses credentials too large to seal before a job exists', () => {
    const oversized = checkSubmissionLimits({ graph: { nodes: { in: { op: 'import.s3', credentials: { ...S3, sessionToken: 'x'.repeat(70_000) }, key: 'a.csv' } } } });
    expect(oversized.map((p) => p.name)).toEqual(['graph.nodes.in.credentials']);
    expect(JSON.stringify(oversized)).not.toContain('xxxx');
    const notAnObject = checkSubmissionLimits({ graph: { nodes: { in: { op: 'export.s3', credentials: 'AKIA...', prefix: 'o/' } } } });
    expect(notAnObject.map((p) => p.reason)).toEqual(['credentials must be an object']);
  });
});
