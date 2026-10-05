import { Command } from 'commander';
const program = new Command();
program.name('hpm')
  .option('-r, --root <path>', 'root')
  .option('-p, --profiles <profiles>', 'Specific profile names to target (repeatable)',
    (value, previous) => (Array.isArray(previous) ? previous.concat(value) : [value]))
  .option('-q, --quiet', 'quiet');
program.command('init [targetDir]').option('-p, --profile <name>', 'profile', 'main')
  .action((targetDir, opts) => console.log('INIT', JSON.stringify({ targetDir, opts })));
program.command('merge [target]')
  .action((target, opts) => console.log('MERGE', JSON.stringify({ target, opts })));
program.parse();
console.log('GLOBAL', JSON.stringify(program.opts()));
