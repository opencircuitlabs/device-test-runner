# Device Test Runner

A portable, adapter-driven runner for firmware bring-up, instrument automation, manufacturing checks, and hardware-in-the-loop tests.

Test plans are declarative JSON. The runner validates them before touching hardware, applies per-step timeouts and retries, preserves setup/teardown semantics, captures measurements into typed variables, evaluates assertions, redacts secrets, and emits JSON, JUnit XML, or SARIF.

## Quick start

```bash
npm install
npm test
node src/cli.js validate examples/power-rail-plan.json
node src/cli.js run examples/power-rail-plan.json \
  --script examples/passing-script.json \
  --junit results.xml --sarif results.sarif
```

The built-in scripted adapter makes plans reproducible in CI. Production adapters implement one method:

```js
const adapter = {
  async execute(command, args, { signal, context }) {
    // Dispatch to a serial device, SCPI instrument, debug probe, or test fixture.
    // Honor signal cancellation and return a JSON-compatible value.
  }
};
```

## Plan structure

A plan has optional `setup`, one or more named `tests`, and optional `teardown`. Teardown always runs, including after setup or test failure.

Step types:

- `command`: invoke the adapter, optionally save output and assert it;
- `assert`: evaluate an existing value or captured variable;
- `delay`: bounded wait without blocking the event loop;
- `log`: add a structured informational record.

Commands support `timeoutMs`, `retries`, `retryDelayMs`, and `continueOnFailure`. Exact `${variable}` substitutions preserve the original type; substitutions inside larger strings interpolate text.

## Expectations

Matchers include strict `equals`, JSON `deepEquals`, `truthy`, `falsy`, string/array `contains`, regular-expression `matches`, numeric `approx`, inclusive `range`, and shallow property `schema` checks. Failures retain actual and expected values in the step record.

## Reports and exit codes

The normalized report contains setup, tests, teardown, individual attempts, durations, failures, logs, and aggregate counts. Variables are omitted unless explicitly requested; configured secret variables are replaced with `[REDACTED]`.

The CLI exits `0` for a passing plan, `2` for a completed plan with test failures, and `1` for invalid configuration or runner failure. JUnit integrates with common CI test views; SARIF surfaces each failed test as a diagnostic.

## Safety

The runner does not provide a shell step. Hardware access is confined to explicitly registered adapter commands, making authorization and cleanup auditable. Adapters should enforce their own voltage/current/range limits and respond to abort signals.

## License

MIT
