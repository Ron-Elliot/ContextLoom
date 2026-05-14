import path from 'path';
import { Config } from '../config';
import pool from '../db';
import { writeArtifact } from './artifactWriter';
import { writeClaims } from './claimWriter';
import { writeEntities } from './entityWriter';
import { buildEnvelope } from './envelope';
import { extractFromFile } from './extractor';
import { walkFiles } from './walker';

export async function runIngest(config: Config, configPath: string): Promise<void> {
  const configDir = path.dirname(path.resolve(configPath));

  let totalFiles = 0;
  let changedFiles = 0;
  const failures: Array<{ file: string; error: string }> = [];

  for (const source of config.sources) {
    const repoPath = path.resolve(configDir, source.path);
    const globs = source.globs ?? ['**/*'];

    const files = walkFiles(repoPath, globs);
    console.log(`Found ${files.length} files in ${source.path}`);

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
            await writeEntities(config.project_id, result.entities);
          }
        }
      } catch (err) {
        const message = (err as Error).message;
        console.error(`Error processing ${relPath}: ${message}`);
        failures.push({ file: relPath, error: message });
      }
    }
  }

  await pool.end();

  if (failures.length > 0) {
    console.error(`\nIngest failed: ${failures.length} file(s) could not be processed:`);
    for (const { file, error } of failures) {
      console.error(`  ${file}: ${error}`);
    }
    throw new Error(`Ingest failed with ${failures.length} file error(s)`);
  }

  console.log(`Ingest complete: ${totalFiles} files processed, ${changedFiles} new or changed`);
}
