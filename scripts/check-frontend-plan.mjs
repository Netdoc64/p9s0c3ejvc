import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const docs = fileURLToPath(new URL("../docs/", import.meta.url));
const planFile = process.argv[2] ?? resolve(docs, "frontend-build-plan.json");

function indexById(entries, label) {
  const index = new Map();
  for (const entry of entries) {
    assert(typeof entry.id === "string" && entry.id.length, `Missing ID for ${label}`);
    assert(!index.has(entry.id), `Duplicate ${label} ID ${entry.id}`);
    index.set(entry.id, entry);
  }
  return index;
}

function checkReferences(ids, index, context) {
  for (const id of ids) assert(index.has(id), `${context} references unknown ID ${id}`);
}

function checkDependencies(entries, label) {
  const seen = new Set();
  for (const entry of entries.values()) {
    checkReferences(entry.depends_on, seen, `${label} ${entry.id} dependency or order`);
    seen.add(entry.id);
  }
}

function checkDocsLink(link) {
  assert(existsSync(resolve(docs, link)), `Missing documentation reference ${link}`);
}

function checkMarkdownLinks(file) {
  const text = readFileSync(resolve(docs, file), "utf8");
  for (const [, link] of text.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
    if (!/^https?:\/\//.test(link)) checkDocsLink(link);
  }
}

function checkPlan(plan) {
  const modules = indexById(plan.modules, "module");
  const decisions = indexById(plan.modules.flatMap((module) => module.open_questions), "decision");
  const screens = indexById(plan.modules.flatMap((module) => module.screens), "screen");
  const tests = indexById(plan.verification, "verification");
  const operations = indexById(plan.api_contract.operations, "API operation");
  const packages = indexById(plan.implementation_handoff.packages, "work package");
  checkDependencies(modules, "Module");
  checkDependencies(packages, "Work package");

  for (const module of modules.values()) {
    checkReferences(module.required_decisions, decisions, module.id);
    checkReferences(module.api_operations, operations, module.id);
    assert(module.acceptance.length > 0, `${module.id} has no acceptance criteria`);
    const expectedDecisions = [...decisions.values()].filter((decision) => decision.blocks.includes(module.id));
    assert.deepEqual(new Set(module.required_decisions), new Set(expectedDecisions.map((item) => item.id)), `${module.id} decision references are out of sync`);
  }
  for (const decision of decisions.values()) checkReferences(decision.blocks, modules, decision.id);
  for (const operation of operations.values()) checkReferences(operation.modules, modules, operation.id);
  for (const test of tests.values()) checkReferences([test.module], modules, test.id);
  assert.deepEqual(plan.phases.flatMap((phase) => phase.modules).sort(), [...modules.keys()].sort(), "Phases must cover each module once");

  for (const item of packages.values()) {
    checkReferences(item.modules, modules, item.id);
    checkReferences(item.required_decisions, decisions, item.id);
    checkReferences(item.acceptance_tests, tests, item.id);
    assert(item.acceptance_tests.length > 0, `${item.id} has no acceptance tests`);
    if (item.stage === "Mock") assert.equal(item.required_decisions.length, 0, `${item.id} is a mock package with a pilot blocker`);
  }
  const readiness = indexById(plan.handoff_readiness.decisions, "handoff decision");
  assert.deepEqual([...readiness.keys()].sort(), [...decisions.keys()].sort(), "Handoff must cover all pilot decisions");

  const routeTargets = new Set([...screens.keys(), ...Object.keys(plan.orchestration.dynamic_targets)]);
  const stateActions = Object.keys(plan.orchestration.state_action_conventions).filter((key) => key.startsWith("@"));
  const controlsByScreen = new Map();
  const statesByScreen = new Map();
  for (const screen of screens.values()) {
    const controls = indexById(screen.controls, `control in ${screen.id}`);
    const states = indexById(screen.states, `state in ${screen.id}`);
    assert(controls.size && states.size, `Missing controls or states in ${screen.id}`);
    controlsByScreen.set(screen.id, controls);
    statesByScreen.set(screen.id, states);
    const actionIds = new Set([...controls.keys(), ...stateActions]);

    for (const control of controls.values()) {
      assert(control.destinations.length, `Missing destination for ${screen.id}.${control.id}`);
      checkReferences(control.destinations, routeTargets, `${screen.id}.${control.id}`);
    }
    for (const state of states.values()) {
      assert(state.recovery_actions.length, `No recovery actions for ${screen.id}.${state.id}`);
      checkReferences(state.recovery_actions, actionIds, `${screen.id}.${state.id}`);
    }
    checkReferences(screen.transitions.map(({ to }) => to), routeTargets, screen.id);
  }

  function lookupState(screen, state) {
    const result = statesByScreen.get(screen)?.get(state);
    assert(result, `Unknown screen or state ${screen}.${state}`);
    return result;
  }

  const traces = indexById(plan.scenario_traces, "trace");
  checkReferences(traces.keys(), tests, "Scenario trace");
  for (const trace of traces.values()) {
    let previousScreen;
    for (const step of trace.steps) {
      const { screen, state, action, next_screen: destination } = step;
      const context = `${trace.id} ${screen}.${state}.${action}`;
      assert(!previousScreen || previousScreen === screen || screen === "navigation", `${context} cannot follow ${previousScreen}`);
      assert(lookupState(screen, state).recovery_actions.includes(action), `${context}: action is not offered by this state`);
      const control = controlsByScreen.get(screen).get(action);
      assert(control?.destinations.includes(destination), `${context} cannot go to ${destination}`);
      previousScreen = destination;
    }
  }

  const contract = plan.api_contract;
  const mappings = [
    ...contract.error_mapping.map((entry) => ({ ...entry, actions: entry.controls })),
    ...contract.checkout_recovery.outcomes,
  ];
  for (const entry of mappings) {
    const allowed = new Set(lookupState(entry.screen, entry.state).recovery_actions);
    checkReferences(entry.actions, allowed, entry.backend_signal ?? entry.id);
  }
  for (const source of contract.existing_backend_refs) checkDocsLink(source);

  const fixtures = indexById(contract.pilot_fixture.scenarios, "fixture");
  for (const fixture of fixtures.values()) {
    checkReferences(fixture.verification, tests, fixture.id);
    for (const step of fixture.steps) {
      const context = `${fixture.id} ${step.operation}`;
      const operation = operations.get(step.operation);
      assert(operation?.wire, `${context} has no wire contract`);
      lookupState(step.ui.screen, step.ui.state);
      const { request, success } = operation.wire;
      if (["create_order", "confirm_order", "cancel_order"].includes(operation.id)) {
        assert(step.request.headers?.["X-Idempotency-Key"], `${context} missing idempotency key`);
      }
      for (const param of request.path ?? []) assert(step.request.path?.[param], `${context} missing path field ${param}`);
      for (const field of request.body_required ?? []) assert(Object.hasOwn(step.request.body ?? {}, field), `${context} missing body field ${field}`);
      for (const line of step.request.body?.lines ?? []) {
        for (const field of request.line_required ?? []) assert(Object.hasOwn(line, field), `${context} missing line field ${field}`);
        assert(Number.isInteger(line.qty) && line.qty > 0, `${context} has an invalid quantity`);
      }
      if (step.response.status === null) {
        assert.equal(step.response.body, null, `${context} timeout cannot include a response body`);
      } else if (step.response.status < 400) {
        assert.equal(step.response.status, success.status, `${context} has the wrong success status`);
        for (const field of success.required ?? []) {
          assert(Object.hasOwn(step.response.body ?? {}, field), `${context} missing response field ${field}`);
        }
      } else {
        assert.equal(step.response.body?.status, step.response.status, `${context} has a mismatched problem status`);
        assert(step.response.body?.code, `${context} has no stable problem code`);
      }
      const body = step.response.body;
      for (const totals of [body?.totals, body?.order?.totals, body?.previous_totals].filter(Boolean)) {
        const amounts = [totals.subtotal_cents, totals.tax_cents, totals.total_cents];
        assert(amounts.every(Number.isSafeInteger), `${context} totals must be integers`);
        assert.equal(amounts[0] + amounts[1], amounts[2], `${context} totals do not add up`);
      }
    }
  }

  const source = plan.backend_alignment.source;
  const backendText = readFileSync(resolve(docs, source), "utf8");
  const backend = JSON.parse(backendText.match(/```json\s*([\s\S]*?)```/)[1]);
  assert.deepEqual(plan.backend_alignment.modules.map((item) => item.backend_module).sort(), backend.modules.map((item) => item.id).sort(), "Backend module crosswalk is out of sync");
  assert.deepEqual(plan.backend_alignment.deferred.map((item) => item.backend_id).sort(), backend.deferred.map((item) => item.id).sort(), "Deferred backend items are out of sync");
  for (const item of plan.backend_alignment.modules) {
    checkDocsLink(item.reference);
    checkReferences(item.frontend_modules, modules, item.backend_module);
  }
  checkMarkdownLinks("frontend-plan.md");

  console.log(`Frontend plan OK: ${modules.size} modules, ${screens.size} screens, ${packages.size} work packages, ${tests.size} tests, ${traces.size} traces, ${fixtures.size} API examples.`);
}

try {
  checkPlan(JSON.parse(readFileSync(planFile, "utf8")));
} catch (error) {
  console.error(`Frontend plan check failed: ${error.message}`);
  process.exitCode = 1;
}
