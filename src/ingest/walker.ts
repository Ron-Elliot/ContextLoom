import { execFileSync } from 'child_process';

export function walkFiles(repoPath: string, globs: string[]): string[] {
  const patterns = (globs.length > 0 ? globs : ['**/*']).map((g) => `:(glob)${g}`);
  const output = execFileSync('git', ['ls-files', '--', ...patterns], {
    cwd: repoPath,
    encoding: 'utf8',
  }).trim();

  if (!output) return [];
  return output.split('\n').filter(Boolean);
}
