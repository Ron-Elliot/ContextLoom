import { Command } from 'commander';
import { loadConfig } from './config';

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
      await loadConfig(options.config);
      console.log('not implemented');
      process.exit(0);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program
  .command('serve')
  .description('Start the MCP server for AI worker access')
  .action(() => {
    console.log('not implemented');
    process.exit(0);
  });

program.parse();
