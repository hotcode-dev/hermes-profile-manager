import { Command } from 'commander';
const acc = (v, prev) => (Array.isArray(prev) ? prev.concat(v) : [v]);
const program = new Command();
program.name('hpm')
  .option('-r, --root <path>', 'root')
  .option('--hermes-dir <path>', 'hermes')
  .option('-p, --profiles <profiles>', 'Specific profile names (repeatable)', acc)
  .option('-d, --dry-run', 'dry')
  .option('-q, --quiet', 'quiet');
program.command('init [targetDir]').option('-p, --profile <name>', 'profile', 'main')
  .action((t, o) => console.log('INIT', JSON.stringify({t, o})));
program.command('merge [target]')
  .action((t, o) => console.log('MERGE', JSON.stringify({t, o})));
program.command('link [target]')
  .action((t, o) => console.log('LINK', JSON.stringify({t, o})));
program.parse();
console.log('GLOBAL', JSON.stringify(program.opts()));
