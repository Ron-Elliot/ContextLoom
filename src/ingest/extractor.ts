import OpenAI from 'openai';
import path from 'path';

export interface EntityExtraction {
  entity_type: 'project' | 'decision' | 'component' | 'constraint';
  name: string;
  description: string;
  attributes: Array<{ key: string; value: string }>;
}

export interface ExtractionResult {
  fileCategory: 'markdown' | 'code' | 'config' | 'test' | 'other';
  summary: string;
  entities?: EntityExtraction[];
  imports?: string[];
  exports?: string[];
  keyValues?: Array<{ key: string; value: string }>;
  assertions?: string[];
}

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!_client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
    _client = new OpenAI({ apiKey });
  }
  return _client;
}

function getFileCategory(filePath: string): 'markdown' | 'code' | 'config' | 'test' | 'other' {
  const basename = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();

  if (/\.(test|spec)\.[^.]+$/.test(basename) || /\.(test|spec)$/.test(basename)) {
    return 'test';
  }
  if (ext === '.md' || ext === '.mdx') return 'markdown';
  if (['.json', '.yaml', '.yml', '.toml', '.ini', '.env', '.properties'].includes(ext)) {
    return 'config';
  }
  if (
    [
      '.ts',
      '.tsx',
      '.js',
      '.jsx',
      '.py',
      '.go',
      '.rs',
      '.java',
      '.cs',
      '.cpp',
      '.c',
      '.rb',
      '.php',
      '.swift',
      '.kt',
      '.scala',
    ].includes(ext)
  ) {
    return 'code';
  }
  return 'other';
}

const SYSTEM_PROMPTS: Record<string, string> = {
  markdown: `You are a code repository analyzer. Extract structured information from this markdown file.
Return a JSON object with:
- summary: string (1-2 sentence summary)
- entities: array of { entity_type: "project"|"decision"|"component"|"constraint", name: string, description: string, attributes: [{key: string, value: string}] }

For attributes, use only the typed keys appropriate to each entity_type:
- project: "summary", "intent"
- decision: "summary", "rationale", "context", "consequences"
- component: "summary", "responsibilities", "dependencies"
- constraint: "description", "rationale"

For ADRs, extract them as entity_type "decision". For components/services/tools mentioned, extract as entity_type "component". Only include entities actually described in the file.`,
  code: `You are a code repository analyzer. Extract structured information from this source code file.
Return a JSON object with:
- summary: string (1-2 sentence summary of what this file does)
- imports: string[] (imported module/package names only, not local paths)
- exports: string[] (exported function, class, interface, or constant names)`,
  config: `You are a code repository analyzer. Extract structured information from this configuration file.
Return a JSON object with:
- summary: string (1-2 sentence summary)
- keyValues: [{key: string, value: string}] (significant configuration key-value pairs, max 20)`,
  test: `You are a code repository analyzer. Extract structured information from this test file.
Return a JSON object with:
- summary: string (1-2 sentence summary of what is tested)
- assertions: string[] (list of behavioral assertions or test case descriptions, max 20)`,
  other: `You are a code repository analyzer. Summarize this file.
Return a JSON object with:
- summary: string (1-2 sentence summary)`,
};

export type Extractor = (filePath: string, content: string) => Promise<ExtractionResult>;

export async function extractFromFile(
  filePath: string,
  content: string
): Promise<ExtractionResult> {
  const fileCategory = getFileCategory(filePath);
  const client = getClient();

  const truncated = content.slice(0, 8000);
  const response = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: SYSTEM_PROMPTS[fileCategory] },
      { role: 'user', content: `File: ${filePath}\n\n${truncated}` },
    ],
    response_format: { type: 'json_object' },
    temperature: 0,
  });

  const raw = JSON.parse(response.choices[0]?.message?.content ?? '{}') as Record<string, unknown>;

  const result: ExtractionResult = {
    fileCategory,
    summary: typeof raw['summary'] === 'string' ? raw['summary'] : '',
  };

  if (fileCategory === 'markdown') {
    result.entities = parseEntities(raw['entities']);
  } else if (fileCategory === 'code') {
    result.imports = parseStringArray(raw['imports']);
    result.exports = parseStringArray(raw['exports']);
  } else if (fileCategory === 'config') {
    result.keyValues = parseKeyValues(raw['keyValues']);
  } else if (fileCategory === 'test') {
    result.assertions = parseStringArray(raw['assertions']);
  }

  return result;
}

function parseEntities(raw: unknown): EntityExtraction[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
    .map((e) => ({
      entity_type: validateEntityType(e['entity_type']),
      name: typeof e['name'] === 'string' ? e['name'].trim() : '',
      description: typeof e['description'] === 'string' ? e['description'].trim() : '',
      attributes: parseKeyValues(e['attributes']),
    }))
    .filter((e) => e.name.length > 0);
}

function validateEntityType(val: unknown): 'project' | 'decision' | 'component' | 'constraint' {
  if (val === 'project' || val === 'decision' || val === 'component' || val === 'constraint') {
    return val;
  }
  return 'component';
}

function parseStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
}

function parseKeyValues(raw: unknown): Array<{ key: string; value: string }> {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((kv): kv is Record<string, unknown> => typeof kv === 'object' && kv !== null)
    .map((kv) => ({
      key: typeof kv['key'] === 'string' ? kv['key'].trim() : '',
      value: typeof kv['value'] === 'string' ? kv['value'].trim() : String(kv['value'] ?? ''),
    }))
    .filter((kv) => kv.key.length > 0);
}
