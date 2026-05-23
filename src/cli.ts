import { Command } from 'commander';
import { loadConfig } from './config';
import pool from './db';
import { runIngest } from './ingest/pipeline';
import { startServer } from './serve/server';
import { DEFAULT_TRUST_FILTER } from './serve/types';

const program = new Command();

program
  .name('contextloom')
  .description('A project-state knowledge system for AI workers')
  .version('0.1.0');

program
  .command('ingest')
  .description('Ingest project artifacts into the context store')
  .requiredOption('--config <path>', 'Path to contextloom.yaml config file')
  .action(async (options: { config: string }) => {
    try {
      const config = await loadConfig(options.config);
      await runIngest(config, options.config);
      await pool.end();
      process.exit(0);
    } catch (err) {
      console.error((err as Error).message);
      await pool.end().catch(() => undefined);
      process.exit(1);
    }
  });

program
  .command('serve')
  .description('Start the MCP server for AI worker access')
  .requiredOption('--config <path>', 'Path to contextloom.yaml config file')
  .action(async (options: { config: string }) => {
    try {
      const config = await loadConfig(options.config);
      const trustFilter = {
        ...DEFAULT_TRUST_FILTER,
        ...(config.serve?.trust_filter ?? {}),
      };
      await startServer(trustFilter);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program.parse();
