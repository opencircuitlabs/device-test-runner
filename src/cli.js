#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { runPlan, ScriptedAdapter, toJUnit, toSarif, validatePlan } from './index.js';

const args = process.argv.slice(2); const value = (flag) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
try {
  const command = args[0] ?? 'run'; const plan = JSON.parse(readFileSync(args[1], 'utf8'));
  if (command === 'validate') { const result = validatePlan(plan); console.log(JSON.stringify(result, null, 2)); if (!result.valid) process.exitCode = 1; }
  else if (command === 'run') {
    const script = value('--script'); if (!script) throw new Error('A --script adapter file is required by the portable CLI'); const adapter = new ScriptedAdapter(JSON.parse(readFileSync(script, 'utf8'))); const report = await runPlan(plan, adapter, { tags: value('--tags')?.split(','), stopOnFailure: args.includes('--stop-on-failure') });
    const output = value('--output'); const text = JSON.stringify(report, null, 2) + '\n'; if (output) writeFileSync(output, text); else process.stdout.write(text); if (value('--junit')) writeFileSync(value('--junit'), toJUnit(report)); if (value('--sarif')) writeFileSync(value('--sarif'), JSON.stringify(toSarif(report), null, 2)); if (report.status !== 'passed') process.exitCode = 2;
  } else throw new Error(`Unknown command: ${command}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
