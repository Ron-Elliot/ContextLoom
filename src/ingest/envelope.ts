import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';
import { v4 as uuidv4, v5 as uuidv5 } from 'uuid';

const NAMESPACE = uuidv5.URL;

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
  const source_uri = relFilePath;
  const artifact_id = uuidv5(`${projectId}\x00${sourceType}\x00${source_uri}`, NAMESPACE);
  const artifact_version_id = uuidv4();

  const absPath = path.join(repoPath, relFilePath);
  const content = readFileSync(absPath, 'utf8');
  const content_hash = createHash('sha256').update(content).digest('hex');

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
