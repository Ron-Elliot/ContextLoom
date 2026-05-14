import { readFile } from 'fs/promises';
import yaml from 'js-yaml';
import { z } from 'zod';

const SourceSchema = z.object({
  type: z.string(),
  path: z.string(),
  globs: z.array(z.string()).optional(),
  extractors: z.array(z.string()).optional(),
});

const CrossProjectLinkSchema = z.object({
  project_id: z.string(),
  relationship: z.string().optional(),
});

export const ConfigSchema = z.object({
  project_id: z.string().min(1, 'project_id is required'),
  name: z.string().min(1, 'name is required'),
  sources: z.array(SourceSchema),
  cross_project_links: z.array(CrossProjectLinkSchema).optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export async function loadConfig(configPath: string): Promise<Config> {
  let raw: unknown;
  try {
    const content = await readFile(configPath, 'utf8');
    raw = yaml.load(content);
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === 'ENOENT') {
      throw new Error(`Config file not found: ${configPath}`);
    }
    throw new Error(`Failed to read config file: ${(err as Error).message}`);
  }

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const messages = result.error.errors
      .map((e) => `  ${e.path.join('.')}: ${e.message}`)
      .join('\n');
    throw new Error(`Invalid config:\n${messages}`);
  }

  return result.data;
}
