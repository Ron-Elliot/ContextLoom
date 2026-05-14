import path from 'path';
import { Config } from '../config';
import pool from '../db';
import { writeArtifact } from './artifactWriter';
import { buildEnvelope } from './envelope';
import { walkFiles } from './walker';

export async function runIngest(config: Config, configPath: string): Promise<void> {
  const configDir = path.dirname(path.resolve(configPath));

  let totalFiles = 0;
  let changedFiles = 0;

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
        if (changed) changedFiles++;
      } catch (err) {
        console.error(`Error processing ${relPath}: ${(err as Error).message}`);
      }
    }
  }

  console.log(`Ingest complete: ${totalFiles} files processed, ${changedFiles} new or changed`);
  await pool.end();
}
