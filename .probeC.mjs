import { Command } from 'commander';
const acc = (v, prev) => (Array.isArray(prev) ? prev.concat(v) : [v]);
const program = new Command();
program.enablePositionalOptions();
program.name('hpm')
  .option('-r, --root <path>', 'root')
  .option('--hermes-dir <path>', 'hermes')
  .option('-p, --profiles <profiles>', 'global profiles (repeatable)', acc)
  .option('-d, --dry-run', 'dry')
  .option('-q, --quiet', 'quiet');
program.command('init [targetDir]').option('-p, --profile <name>', 'profile', 'main')
  .action((t, o) => console.log('INIT', JSON.stringify({t, o, GLOBAL: program.opts().profiles})));
program.command('merge [target]').option('-p, --profiles <profiles>', 'local profiles', acc)
  .action((t, o) => console.log('MERGE', JSON.stringify({t, o, GLOBAL: program.opts().profiles})));
program.command('link [target]').option('-p, --profiles <profiles>', 'local profiles', acc)
  .action((t, o) => console.log('LINK', JSON.stringify({t, o, GLOBAL: program.opts().profiles})));
program.command('sync').option('-p, --profiles <profiles>', 'local profiles', acc)
  .action((o) => console.log('SYNC', JSON.stringify({o, GLOBAL: program.opts().profiles})));
program.parse();
