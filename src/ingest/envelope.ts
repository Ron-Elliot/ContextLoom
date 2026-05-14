import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';
import { v4 as uuidv4, v5 as uuidv5 } from 'uuid';

// Stable namespace for all ContextLoom artifact IDs.
const CONTEXTLOOM_ARTIFACT_NAMESPACE = uuidv5.URL;

// artifact_id = uuidv5(CONTEXTLOOM_ARTIFACT_NAMESPACE,
//   "artifact:v1" + "\x00" + project_id + "\x00" + source_type + "\x00" + canonical_source_uri)
// canonical_source_uri: repo-relative POSIX path, no leading "./", no commit SHA, "/" separators.
function toCanonicalUri(relFilePath: string): string {
  return relFilePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function assertNoNul(value: string, label: string): void {
  if (value.includes('\x00')) {
    throw new Error(`UUID v5 component "${label}" must not contain NUL bytes`);
  }
}

export interface Provenance {
  commit_sha: string;
  author: string;
  timestamp: string;
}

export interface Envelope {
  artifact_id: string;
  artifact_version_id: string;
  source_uri: string;
  content: string;
  content_hash: string;
  provenance: Provenance;
  source_modified_at: Date | null;
  extractor: string;
  envelope_version: string;
}

export function buildEnvelope(
  repoPath: string,
  relFilePath: string,
  projectId: string,
  sourceType: string
): Envelope {
  const source_uri = toCanonicalUri(relFilePath);
  assertNoNul(projectId, 'project_id');
  assertNoNul(sourceType, 'source_type');
  assertNoNul(source_uri, 'source_uri');
  const artifact_id = uuidv5(
    `artifact:v1\x00${projectId}\x00${sourceType}\x00${source_uri}`,
    CONTEXTLOOM_ARTIFACT_NAMESPACE
  );
  const artifact_version_id = uuidv4();

  const absPath = path.join(repoPath, relFilePath);
  const rawBytes = readFileSync(absPath);
  const content_hash = createHash('sha256').update(rawBytes).digest('hex');
  const content = rawBytes.toString('utf8');

  const gitOutput = execFileSync('git', ['log', '-1', '--format=%H\t%ae\t%aI', '--', relFilePath], {
    cwd: repoPath,
    encoding: 'utf8',
  }).trim();

  let provenance: Provenance;
  let source_modified_at: Date | null = null;

  if (gitOutput) {
    const parts = gitOutput.split('\t');
    const commit_sha = parts[0] ?? '';
    const author = parts[1] ?? '';
    const timestamp = parts[2] ?? '';
    provenance = { commit_sha, author, timestamp };
    if (timestamp) source_modified_at = new Date(timestamp);
  } else {
    provenance = { commit_sha: '', author: '', timestamp: '' };
  }

  return {
    artifact_id,
    artifact_version_id,
    source_uri,
    content,
    content_hash,
    provenance,
    source_modified_at,
    extractor: 'default',
    envelope_version: '1',
  };
}
