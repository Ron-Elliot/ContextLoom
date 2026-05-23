import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { Config } from '../config';
import pool from '../db';
import { logger } from '../logger';
import { writeArtifact } from './artifactWriter';
import { writeClaims } from './claimWriter';
import { embedEntities } from './embedder';
import { writeEntities } from './entityWriter';
import { buildEnvelope } from './envelope';
import { extractFromFile } from './extractor';
import { reconcileEntities } from './reconciler';
import { propagateStaleness } from './staleness';
import { walkFiles } from './walker';

export async function runIngest(config: Config, configPath: string): Promise<void> {
  const runId = uuidv4();
  const log = logger.child({ run_id: runId });

  const configDir = path.dirname(path.resolve(configPath));

  let totalFiles = 0;
  let changedFiles = 0;
  const failures: Array<{ file: string; error: string }> = [];
  const allEntityIds: string[] = [];

  for (const source of config.sources) {
    const repoPath = path.resolve(configDir, source.path);
    const globs = source.globs ?? ['**/*'];

    const files = walkFiles(repoPath, globs);
    log.info({ source_path: source.path, file_count: files.length }, 'source files discovered');

    for (const relPath of files) {
      try {
        const envelope = buildEnvelope(repoPath, relPath, config.project_id, source.type);
        const { changed } = await writeArtifact(config.project_id, source.type, envelope);
        totalFiles++;
        if (changed) {
          changedFiles++;
          const result = await extractFromFile(relPath, envelope.content);
          await writeClaims(envelope.artifact_id, envelope.artifact_version_id, result);
          if (result.entities && result.entities.length > 0) {
            const entityIds = await writeEntities(
              config.project_id,
              result.entities,
              envelope.artifact_version_id
            );
            allEntityIds.push(...entityIds);
          }
          await propagateStaleness(envelope.artifact_version_id);
        }
      } catch (err) {
        const message = (err as Error).message;
        log.error({ file: relPath, err: message }, 'file processing failed');
        failures.push({ file: relPath, error: message });
      }
    }
  }

  if (allEntityIds.length > 0) {
    await embedEntities(allEntityIds);
    await reconcileEntities(config.project_id, allEntityIds);
  }

  await pool.end();

  if (failures.length > 0) {
    log.error({ failure_count: failures.length, failures }, 'ingest completed with errors');
    throw new Error(`Ingest failed with ${failures.length} file error(s)`);
  }

  log.info({ total_files: totalFiles, changed_files: changedFiles }, 'ingest complete');
}
