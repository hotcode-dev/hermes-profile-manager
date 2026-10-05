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
// init: single -p/--profile
program.command('init [targetDir]')
  .option('-p, --profile <name>', 'initial profile', 'main')
  .action((t, o) => console.log('INIT', JSON.stringify({ t, o })));
// others: repeatable -p/--profiles (list)
const P = '-p, --profiles <profiles>';
for (const [n, args] of [['merge [target]'],['link [target]'],['sync'],['merge-all'],['config-merge'],['jobs-merge'],['soul-merge'],['skills-link'],['plugins-link'],['hermes-link']]) {
  const c = program.command(n).option(P, 'profiles', acc);
  const handler = (a, o) => console.log('CMD', n, JSON.stringify({ a, o }));
  c.action(args === 'sync' || args === 'merge-all' ? (o) => console.log('CMD', n, JSON.stringify(o)) : handler);
}
program.parse();
console.log('GLOBAL', JSON.stringify(program.opts()));
