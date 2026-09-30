import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateExpectation, executeStep, resolveValue, runPlan, ScriptedAdapter, toJUnit, toSarif, validatePlan } from '../src/index.js';
const plan = JSON.parse(readFileSync(new URL('../examples/power-rail-plan.json', import.meta.url), 'utf8'));
const script = JSON.parse(readFileSync(new URL('../examples/passing-script.json', import.meta.url), 'utf8'));

test('example plan validates', () => assert.deepEqual(validatePlan(plan), { valid: true, issues: [] }));
test('template resolution preserves typed exact values and interpolates strings', () => {
  assert.equal(resolveValue('${voltage}', { voltage: 3.3 }), 3.3); assert.equal(resolveValue('rail=${voltage}', { voltage: 3.3 }), 'rail=3.3'); assert.throws(() => resolveValue('${missing}', {}), /Unknown variable/);
});
test('expectation engine supports numeric, structural, text, and range checks', () => {
  assert.equal(evaluateExpectation(3.31, { matcher: 'approx', value: 3.3, tolerance: 0.02 }).pass, true);
  assert.equal(evaluateExpectation(7, { matcher: 'range', min: 5, max: 8 }).pass, true);
  assert.equal(evaluateExpectation('ready:42', { matcher: 'matches', value: '^ready' }).pass, true);
  assert.equal(evaluateExpectation({ ok: true }, { matcher: 'schema', value: { ok: 'boolean' } }).pass, true);
});
test('passing plan executes setup, test, teardown, variables, and logs', async () => {
  const adapter = new ScriptedAdapter(script); const report = await runPlan(plan, adapter, { includeVariables: true }); assert.equal(report.status, 'passed'); assert.equal(report.counts.passed, 1); assert.equal(report.variables.measuredVoltage, 3.31); assert.match(report.logs[0].message, /3\.31/); assert.equal(adapter.assertComplete(), true);
});
test('failed command retries and can recover', async () => {
  const adapter = new ScriptedAdapter([{ command: 'probe', error: 'offline' }, { command: 'probe', result: 42 }]); const context = { variables: {}, logs: [] }; const result = await executeStep({ type: 'command', command: 'probe', retries: 1, expect: { matcher: 'equals', value: 42 } }, context, adapter); assert.equal(result.status, 'passed'); assert.equal(result.attempts.length, 2);
});
test('step timeout becomes a structured failure', async () => {
  const adapter = new ScriptedAdapter([{ command: 'slow', delayMs: 50, result: true }]); const result = await executeStep({ type: 'command', command: 'slow', timeoutMs: 5 }, { variables: {}, logs: [] }, adapter); assert.equal(result.status, 'failed'); assert.match(result.message, /timed out/);
});
test('teardown always executes after a test failure', async () => {
  const failing = structuredClone(plan); const adapter = new ScriptedAdapter([{ command: 'supply.enable', result: true }, { command: 'meter.voltage', result: 4.2 }, { command: 'supply.disable', result: true }]); const report = await runPlan(failing, adapter); assert.equal(report.status, 'failed'); assert.equal(report.teardown[0].status, 'passed'); assert.equal(adapter.calls.at(-1).command, 'supply.disable');
});
test('setup failure skips tests but still attempts teardown', async () => {
  const adapter = new ScriptedAdapter([{ command: 'supply.enable', result: false }, { command: 'supply.disable', result: true }]); const report = await runPlan(plan, adapter); assert.equal(report.tests[0].status, 'skipped'); assert.equal(report.teardown[0].status, 'passed');
});
test('tag selection executes only matching tests', async () => {
  const extended = structuredClone(plan); extended.tests.push({ name: 'long test', tags: ['soak'], steps: [] }); const report = await runPlan(extended, new ScriptedAdapter(script), { tags: ['smoke'] }); assert.equal(report.tests.length, 1);
});
test('secret output variables are redacted', async () => {
  const secretPlan = { schemaVersion: 1, name: 'secret', variables: { token: 'abc' }, tests: [{ name: 'noop', steps: [] }] }; const report = await runPlan(secretPlan, new ScriptedAdapter([]), { includeVariables: true, secretVariables: ['token'] }); assert.equal(report.variables.token, '[REDACTED]');
});
test('JUnit escapes names and records failures', () => {
  const report = { plan: 'A&B', durationMs: 10, counts: { total: 1, failed: 1, skipped: 0 }, tests: [{ name: '<rail>', status: 'failed', durationMs: 2, steps: [{ status: 'failed', message: 'bad <value>' }] }] }; const xml = toJUnit(report); assert.match(xml, /A&amp;B/); assert.match(xml, /bad &lt;value&gt;/);
});
test('SARIF emits one result per failed test', () => {
  const report = { plan: 'x', tests: [{ name: 'a', status: 'failed', steps: [{ status: 'failed', message: 'bad' }] }, { name: 'b', status: 'passed', steps: [] }] }; assert.equal(toSarif(report).runs[0].results.length, 1);
});
test('validator reports duplicate names and unsupported steps', () => {
  const bad = structuredClone(plan); bad.tests.push({ name: bad.tests[0].name, steps: [{ type: 'shell' }] }); const result = validatePlan(bad); assert.equal(result.valid, false); assert.ok(result.issues.length >= 2);
});
