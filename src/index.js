const ID = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const STEP_TYPES = new Set(['command', 'assert', 'delay', 'log']);

export function validatePlan(plan) {
  const issues = []; const fail = (path, message) => issues.push({ path, message });
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return { valid: false, issues: [{ path: '$', message: 'must be an object' }] };
  if (plan.schemaVersion !== 1) fail('schemaVersion', 'must equal 1'); if (!plan.name?.trim()) fail('name', 'is required');
  if (!Array.isArray(plan.tests) || !plan.tests.length) fail('tests', 'must be a non-empty array'); const names = new Set();
  for (const [i, test] of (plan.tests ?? []).entries()) { if (!test.name?.trim()) fail(`tests.${i}.name`, 'is required'); if (names.has(test.name)) fail(`tests.${i}.name`, 'is duplicated'); names.add(test.name); validateSteps(test.steps, `tests.${i}.steps`, fail); }
  validateSteps(plan.setup ?? [], 'setup', fail); validateSteps(plan.teardown ?? [], 'teardown', fail);
  return { valid: issues.length === 0, issues };
}
function validateSteps(steps, path, fail) { if (!Array.isArray(steps)) { fail(path, 'must be an array'); return; } for (const [i, step] of steps.entries()) { if (!STEP_TYPES.has(step.type)) fail(`${path}.${i}.type`, 'is unsupported'); if (step.type === 'command' && !ID.test(step.command ?? '')) fail(`${path}.${i}.command`, 'must be a command identifier'); if (step.type === 'assert' && !step.expect) fail(`${path}.${i}.expect`, 'is required'); if (step.type === 'delay' && (!Number.isFinite(step.ms) || step.ms < 0)) fail(`${path}.${i}.ms`, 'must be non-negative'); if (step.timeoutMs != null && (!Number.isFinite(step.timeoutMs) || step.timeoutMs <= 0)) fail(`${path}.${i}.timeoutMs`, 'must be positive'); if (step.retries != null && (!Number.isInteger(step.retries) || step.retries < 0)) fail(`${path}.${i}.retries`, 'must be a non-negative integer'); } }

export function resolveValue(value, variables) {
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, variables));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveValue(item, variables)]));
  if (typeof value !== 'string') return value; const exact = value.match(/^\$\{([A-Za-z_][A-Za-z0-9_.-]*)\}$/); if (exact) { if (!(exact[1] in variables)) throw new Error(`Unknown variable: ${exact[1]}`); return variables[exact[1]]; }
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_.-]*)\}/g, (_, name) => { if (!(name in variables)) throw new Error(`Unknown variable: ${name}`); return String(variables[name]); });
}

export function evaluateExpectation(actual, expect) {
  if (!expect || typeof expect !== 'object') throw new Error('Expectation must be an object'); const matcher = expect.matcher ?? 'equals'; const expected = expect.value; let pass;
  if (matcher === 'equals') pass = Object.is(actual, expected);
  else if (matcher === 'deepEquals') pass = JSON.stringify(actual) === JSON.stringify(expected);
  else if (matcher === 'truthy') pass = Boolean(actual);
  else if (matcher === 'falsy') pass = !actual;
  else if (matcher === 'contains') pass = typeof actual === 'string' || Array.isArray(actual) ? actual.includes(expected) : false;
  else if (matcher === 'matches') pass = typeof actual === 'string' && new RegExp(expected, expect.flags ?? '').test(actual);
  else if (matcher === 'approx') pass = Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= (expect.tolerance ?? 0);
  else if (matcher === 'range') pass = Number.isFinite(actual) && (expect.min == null || actual >= expect.min) && (expect.max == null || actual <= expect.max);
  else if (matcher === 'schema') pass = Object.entries(expected ?? {}).every(([key, type]) => actual != null && typeof actual[key] === type);
  else throw new Error(`Unsupported matcher: ${matcher}`);
  return { pass, matcher, actual, expected: expected ?? (matcher === 'range' ? { min: expect.min, max: expect.max } : undefined), message: pass ? null : expect.message ?? `Expected ${JSON.stringify(actual)} to satisfy ${matcher} ${JSON.stringify(expected ?? expect)}` };
}

function timeoutPromise(promise, timeoutMs, controller) { if (!timeoutMs) return promise; return new Promise((resolve, reject) => { const timer = setTimeout(() => { controller.abort(); reject(new Error(`Step timed out after ${timeoutMs} ms`)); }, timeoutMs); Promise.resolve(promise).then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); }); }); }
const delay = (ms, signal) => new Promise((resolve, reject) => { const timer = setTimeout(resolve, ms); signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Delay aborted')); }, { once: true }); });

export async function executeStep(step, context, adapter, options = {}) {
  const started = performance.now(); const attempts = []; const maxAttempts = (step.retries ?? 0) + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController(); try {
      let output;
      if (step.type === 'command') output = await timeoutPromise(adapter.execute(step.command, resolveValue(step.args ?? {}, context.variables), { signal: controller.signal, context }), step.timeoutMs ?? options.defaultTimeoutMs, controller);
      else if (step.type === 'assert') { const actual = resolveValue(step.actual, context.variables); const expect = resolveValue(step.expect, context.variables); const assertion = evaluateExpectation(actual, expect); if (!assertion.pass) { const error = new Error(assertion.message); error.assertion = assertion; throw error; } output = assertion; }
      else if (step.type === 'delay') { await timeoutPromise(delay(step.ms, controller.signal), step.timeoutMs ?? Math.max(step.ms + 100, options.defaultTimeoutMs ?? 0), controller); output = { waitedMs: step.ms }; }
      else if (step.type === 'log') { output = resolveValue(step.message ?? '', context.variables); context.logs.push({ level: step.level ?? 'info', message: String(output) }); }
      if (step.expect && step.type === 'command') { const assertion = evaluateExpectation(output, resolveValue(step.expect, context.variables)); if (!assertion.pass) { const error = new Error(assertion.message); error.assertion = assertion; throw error; } }
      if (step.saveAs) context.variables[step.saveAs] = output;
      attempts.push({ attempt, status: 'passed' }); return { status: 'passed', type: step.type, name: step.name ?? step.command ?? step.type, output, attempts, durationMs: performance.now() - started };
    } catch (error) { attempts.push({ attempt, status: 'failed', message: error.message }); if (attempt === maxAttempts) return { status: 'failed', type: step.type, name: step.name ?? step.command ?? step.type, message: error.message, assertion: error.assertion, attempts, durationMs: performance.now() - started }; if (step.retryDelayMs) await delay(step.retryDelayMs); }
  }
}

async function runSteps(steps, context, adapter, options, phase) { const results = []; for (const [index, step] of steps.entries()) { const result = await executeStep(step, context, adapter, options); result.phase = phase; result.index = index; results.push(result); if (result.status === 'failed' && !step.continueOnFailure) break; } return results; }

export async function runPlan(input, adapter, options = {}) {
  const validation = validatePlan(input); if (!validation.valid) throw new Error(validation.issues.map((x) => `${x.path}: ${x.message}`).join('; ')); if (!adapter || typeof adapter.execute !== 'function') throw new Error('adapter.execute is required');
  const startedAt = new Date().toISOString(); const started = performance.now(); const context = { variables: structuredClone(input.variables ?? {}), logs: [] }; const setup = await runSteps(input.setup ?? [], context, adapter, options, 'setup'); const setupPassed = setup.every((x) => x.status === 'passed'); const tests = [];
  if (setupPassed) for (const test of input.tests) { if (options.tags?.length && !options.tags.some((tag) => test.tags?.includes(tag))) continue; const before = performance.now(); const steps = await runSteps(test.steps, context, adapter, options, 'test'); const passed = steps.every((x) => x.status === 'passed'); tests.push({ name: test.name, tags: test.tags ?? [], status: passed ? 'passed' : 'failed', durationMs: performance.now() - before, steps }); if (!passed && options.stopOnFailure) break; }
  else for (const test of input.tests) tests.push({ name: test.name, tags: test.tags ?? [], status: 'skipped', durationMs: 0, reason: 'setup failed', steps: [] });
  const teardown = await runSteps(input.teardown ?? [], context, adapter, options, 'teardown'); const counts = { total: tests.length, passed: tests.filter((x) => x.status === 'passed').length, failed: tests.filter((x) => x.status === 'failed').length, skipped: tests.filter((x) => x.status === 'skipped').length };
  const report = { schemaVersion: 1, plan: input.name, startedAt, durationMs: performance.now() - started, status: setupPassed && counts.failed === 0 && teardown.every((x) => x.status === 'passed') ? 'passed' : 'failed', counts, setup, tests, teardown, logs: context.logs, variables: options.includeVariables ? redact(context.variables, options.secretVariables ?? []) : undefined };
  return report;
}

function redact(variables, secrets) { return Object.fromEntries(Object.entries(variables).map(([key, value]) => [key, secrets.includes(key) ? '[REDACTED]' : value])); }
const xml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
export function toJUnit(report) { const cases = report.tests.map((test) => { const failure = test.steps.find((step) => step.status === 'failed'); return `  <testcase name="${xml(test.name)}" classname="${xml(report.plan)}" time="${(test.durationMs / 1000).toFixed(6)}">${test.status === 'failed' ? `\n    <failure message="${xml(failure?.message ?? 'failed')}">${xml(JSON.stringify(failure ?? {}))}</failure>\n  ` : test.status === 'skipped' ? `\n    <skipped message="${xml(test.reason)}"/>\n  ` : ''}</testcase>`; }); return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${xml(report.plan)}" tests="${report.counts.total}" failures="${report.counts.failed}" skipped="${report.counts.skipped}" time="${(report.durationMs / 1000).toFixed(6)}">\n${cases.join('\n')}\n</testsuite>\n`; }
export function toSarif(report) { return { version: '2.1.0', $schema: 'https://json.schemastore.org/sarif-2.1.0.json', runs: [{ tool: { driver: { name: 'OpenCircuitLabs Device Test Runner', rules: [{ id: 'DEVICE_TEST_FAILURE', shortDescription: { text: 'Device test failure' } }] } }, results: report.tests.filter((t) => t.status === 'failed').map((test) => ({ ruleId: 'DEVICE_TEST_FAILURE', level: 'error', message: { text: `${test.name}: ${test.steps.find((s) => s.status === 'failed')?.message ?? 'failed'}` }, properties: { test: test.name } })) }] }; }

export class ScriptedAdapter {
  constructor(script = []) { this.script = [...script]; this.calls = []; }
  async execute(command, args) { this.calls.push({ command, args }); const expected = this.script.shift(); if (!expected) throw new Error(`Unexpected command: ${command}`); if (expected.command !== command) throw new Error(`Expected command ${expected.command}, received ${command}`); if (expected.delayMs) await delay(expected.delayMs); if (expected.error) throw new Error(expected.error); return structuredClone(expected.result); }
  assertComplete() { if (this.script.length) throw new Error(`${this.script.length} scripted commands were not executed`); return true; }
}
