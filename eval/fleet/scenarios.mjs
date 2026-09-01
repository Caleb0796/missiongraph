import { randomUUID } from "node:crypto";

import { assert, assertEqual, taskNodes } from "./lib/client.mjs";

function errorCode(result) {
  return result.body?.error?.code;
}

function expectError(result, status, code, label) {
  assertEqual(result.status, status, label);
  assertEqual(errorCode(result), code, `${label} error code`);
}

async function cloneNodes(client, minimum = 1) {
  const clone = await client.clone();
  const snapshot = await client.snapshot(clone);
  const nodes = taskNodes(snapshot).filter(
    (node) => node.state === "queued" && node.availability === "ready" && !node.assigned,
  );
  assert(nodes.length >= minimum, `clone needs at least ${minimum} ready, unassigned template nodes`);
  return { clone, nodes };
}

async function dispatchAndEnqueue(client, clone, node, options = undefined) {
  await client.dispatch(clone, node.id, options);
  const result = await client.enqueue(clone, node.id);
  const body = client.expectStatus(result, 200, "enqueue dispatched template node");
  assertEqual(body.status, "queued", "new fleet request status");
  assert(Number.isInteger(body.position) && body.position >= 1, "new fleet request has no queue position");
  return body;
}

async function claimExpected(client, expected) {
  const claim = await client.next();
  const body = client.expectStatus(claim, 200, "claim next fleet request");
  assertEqual(body.request_id, expected.id, "claim request id");
  assertEqual(body.project_id, expected.clone.project, "claim project id");
  assertEqual(body.node_id, expected.node.id, "claim node id");
  assert(body.visitor_token === expected.clone.token, "claim returned the wrong project-bound visitor token");
  assertEqual(body.node.title, expected.node.title, "claim node title");
  assertEqual(body.node.brief, expected.brief ?? expected.node.brief, "claim node brief");
  return body;
}

async function finishClaim(client, requestId) {
  client.expectStatus(await client.heartbeat(requestId), 200, "heartbeat adopted request");
  client.expectStatus(await client.complete(requestId, "done"), 200, "complete adopted request");
}

async function runMockWorker(client, clone, node, requestId) {
  client.expectStatus(await client.heartbeat(requestId), 200, "start adopted request");
  const credential = await client.workerCredential(clone, node.id);
  const actor = `worker:${node.id}`;
  await client.report(clone, credential.token, actor, "NODE_STATE_CHANGED", {
    node_id: node.id,
    from: "queued",
    to: "running",
  });
  await client.report(clone, credential.token, actor, "WORKER_LOG", {
    node_id: node.id,
    lines: ["fleet eval mock worker started", "fleet eval mock worker finished"],
  });
  await client.report(clone, credential.token, actor, "HANDOFF_FILED", {
    node_id: node.id,
    handoff: {
      v: 1,
      summary: "Fleet eval mock worker completed the template task.",
      files: [],
      commits: [],
      tests: "green",
      downstream_notes: "No downstream action required.",
      deviations: [],
      artifacts: [],
    },
  });
  await client.report(clone, client.reporterToken, "supervisor", "APPROVAL_CREATED", {
    approval_id: `fleet-eval-approval-${randomUUID()}`,
    node_id: node.id,
    summary: "Review the fleet eval mock handoff.",
    tests: "green",
  });
  client.expectStatus(await client.complete(requestId, "done", "mock worker completed"), 200, "complete mock worker request");
}

async function assertHappyLedger(events, nodeId) {
  const lifecycle = events.filter((event) => event.payload?.node_id === nodeId).map((event) => event.type);
  for (const type of ["NODE_STATE_CHANGED", "WORKER_LOG", "HANDOFF_FILED", "APPROVAL_CREATED"]) {
    assert(lifecycle.includes(type), `clone ledger is missing ${type} for the adopted node`);
  }
}

export const scenarios = [
  {
    name: "happy-path",
    async run(context) {
      const { client, mode } = context;
      const sibling = await client.clone();
      const siblingBefore = await client.exportLedger(sibling);
      const { clone, nodes } = await cloneNodes(client);
      const node = nodes[0];
      const queued = await dispatchAndEnqueue(client, clone, node);

      if (mode === "stub") {
        await claimExpected(client, { id: queued.id, clone, node });
        await runMockWorker(client, clone, node, queued.id);
      } else {
        const terminal = await client.waitFor(
          "the bridge to adopt and finish the fleet request",
          async () => client.expectStatus(await client.getRequest(clone, queued.id), 200, "poll fleet request"),
          (body) => body.status === "done" || body.status === "failed" || body.status === "expired",
          { intervalMs: 500 },
        );
        assertEqual(terminal.status, "done", "real bridge fleet outcome");
        assert(typeof terminal.adopted_at === "string", "real bridge request never exposed adoption");
      }

      const request = client.expectStatus(await client.getRequest(clone, queued.id), 200, "read completed request");
      assertEqual(request.status, "done", "happy-path terminal request status");
      await assertHappyLedger(await client.exportLedger(clone), node.id);
      const siblingAfter = await client.exportLedger(sibling);
      assertEqual(siblingAfter.length, siblingBefore.length, "worker lifecycle leaked into a different clone ledger");
    },
  },
  {
    name: "seed-project-rejection",
    stubOnly: true,
    async run({ client, controls }) {
      const seed = controls.seedProject;
      const nodes = taskNodes(await client.snapshot(seed));
      assert(nodes.length >= 1, "configured seed project has no task templates");
      await client.dispatch(seed, nodes[0].id);
      expectError(await client.enqueue(seed, nodes[0].id), 400, "template_mismatch", "reject configured seed project");
    },
  },
  {
    name: "seed-registry-addition",
    stubOnly: true,
    async run({ client, controls }) {
      const title = `Added seed template ${randomUUID()}`;
      const brief = "A template added to the configured seed registry must become eligible in later clones.";
      controls.addSeedTemplate({ title, brief });
      const { clone, nodes } = await cloneNodes(client, 4);
      const added = nodes.find((node) => node.title === title && node.brief === brief);
      assert(added, "clone did not fold the added seed template");
      const queued = await dispatchAndEnqueue(client, clone, added);
      await claimExpected(client, { id: queued.id, clone, node: added });
      await finishClaim(client, queued.id);
    },
  },
  {
    name: "seed-registry-tombstone",
    stubOnly: true,
    async run({ client, controls }) {
      const { clone, nodes } = await cloneNodes(client);
      const seedNodes = taskNodes(await client.snapshot(controls.seedProject));
      const template = seedNodes.find((node) => node.title === nodes[0].title && node.brief === nodes[0].brief);
      assert(template, "clone template is absent from the configured seed project");
      controls.removeSeedTemplate(template.id);
      await client.dispatch(clone, nodes[0].id);
      expectError(await client.enqueue(clone, nodes[0].id), 400, "template_mismatch", "reject tombstoned seed template");
    },
  },
  {
    name: "template_mismatch",
    async run({ client }) {
      const { clone } = await cloneNodes(client);
      const nodeId = await client.addTask(clone, {
        title: `Judge custom task ${randomUUID()}`,
        brief: "This task is not present in the seed template registry.",
      });
      await client.dispatch(clone, nodeId);
      const before = client.expectStatus(await client.fleetStatus(clone), 200, "read queue depth before rejection");
      expectError(await client.enqueue(clone, nodeId), 400, "template_mismatch", "reject judge-added custom task");
      const after = client.expectStatus(await client.fleetStatus(clone), 200, "read queue depth after rejection");
      assertEqual(after.queue_depth, before.queue_depth, "template mismatch changed queue depth");
    },
  },
  {
    name: "undispatched-custom-precedence",
    async run({ client }) {
      const { clone } = await cloneNodes(client);
      const nodeId = await client.addTask(clone, {
        title: `Undispatched custom task ${randomUUID()}`,
        brief: "Dispatch state must be classified before template membership.",
      });
      expectError(await client.enqueue(clone, nodeId), 400, "node_not_dispatched", "reject undispatched custom task");
    },
  },
  {
    name: "post-baseline-authored-enqueue",
    async run({ client }) {
      const { clone, nodes } = await cloneNodes(client);
      const nodeId = await client.addTask(clone, {
        title: nodes[0].title,
        brief: nodes[0].brief,
        estimate: nodes[0].estimate_min,
      });
      await client.dispatch(clone, nodeId);
      expectError(
        await client.enqueue(clone, nodeId),
        400,
        "template_mismatch",
        "reject post-baseline exact-copy task at enqueue",
      );
    },
  },
  {
    name: "post-baseline-authored-claim",
    stubOnly: true,
    async run({ client, controls }) {
      const authored = await cloneNodes(client);
      const nodeId = await client.addTask(authored.clone, {
        title: authored.nodes[0].title,
        brief: authored.nodes[0].brief,
        estimate: authored.nodes[0].estimate_min,
      });
      await client.dispatch(authored.clone, nodeId);
      const authoredRequest = controls.enqueueUnchecked(authored.clone.project, nodeId);
      const inherited = await cloneNodes(client);
      const inheritedRequest = await dispatchAndEnqueue(client, inherited.clone, inherited.nodes[0]);

      await claimExpected(client, {
        id: inheritedRequest.id,
        clone: inherited.clone,
        node: inherited.nodes[0],
      });
      const mismatch = client.expectStatus(
        await client.getRequest(authored.clone, authoredRequest.id),
        200,
        "read post-baseline claim rejection",
      );
      assertEqual(mismatch.status, "failed", "post-baseline claim rejection status");
      assertEqual(mismatch.outcome, "template_mismatch", "post-baseline claim rejection outcome");
      await finishClaim(client, inheritedRequest.id);
    },
  },
  {
    name: "post-baseline-split-child",
    stubOnly: true,
    async run({ client, controls }) {
      const { clone, nodes } = await cloneNodes(client);
      const child = controls.addSplitChild(clone.project, nodes[0].id, {
        id: `fleet-eval-split-${randomUUID()}`,
        title: nodes[0].title,
        brief: nodes[0].brief,
        estimate_min: nodes[0].estimate_min,
        tags: ["fleet-eval"],
        state: "queued",
      });
      await client.dispatch(clone, child.id);
      expectError(
        await client.enqueue(clone, child.id),
        400,
        "template_mismatch",
        "reject post-baseline split child",
      );
    },
  },
  {
    name: "edited-brief",
    async run({ client }) {
      const { clone, nodes } = await cloneNodes(client);
      const node = nodes[0];
      await client.dispatch(clone, node.id, { briefOverride: node.brief });
      const rejected = await client.enqueue(clone, node.id);
      expectError(rejected, 400, "template_mismatch", "reject dispatched brief_override");
      assert(
        rejected.body?.error?.message?.includes("brief_override"),
        "brief_override rejection message does not name brief_override",
      );
    },
  },
  {
    name: "node_not_dispatched",
    async run({ client }) {
      const { clone, nodes } = await cloneNodes(client);
      expectError(await client.enqueue(clone, nodes[0].id), 400, "node_not_dispatched", "reject undispatched node");
    },
  },
  {
    name: "eligibility-projection",
    stubOnly: true,
    async run({ client, controls }) {
      const stateCase = await cloneNodes(client);
      await client.dispatch(stateCase.clone, stateCase.nodes[0].id);
      controls.setNode(stateCase.clone.project, stateCase.nodes[0].id, { state: "running" });
      expectError(
        await client.enqueue(stateCase.clone, stateCase.nodes[0].id),
        400,
        "node_not_dispatched",
        "reject non-queued projection",
      );

      const recordCase = await cloneNodes(client);
      await client.dispatch(recordCase.clone, recordCase.nodes[0].id);
      controls.setNode(recordCase.clone.project, recordCase.nodes[0].id, { record_type: "group" });
      expectError(await client.enqueue(recordCase.clone, recordCase.nodes[0].id), 404, "node_not_found", "reject group record");

      const assignedCase = await cloneNodes(client);
      await client.dispatch(assignedCase.clone, assignedCase.nodes[0].id);
      controls.setNode(assignedCase.clone.project, assignedCase.nodes[0].id, { dispatched: false });
      const queued = client.expectStatus(
        await client.enqueue(assignedCase.clone, assignedCase.nodes[0].id),
        200,
        "accept assigned projection independent of stub-only dispatched flag",
      );
      await claimExpected(client, { id: queued.id, clone: assignedCase.clone, node: assignedCase.nodes[0] });
      await finishClaim(client, queued.id);
    },
  },
  {
    name: "per-project-cap",
    stubOptions: { perProjectCap: 1, ttlMin: 0.001 },
    async run(context) {
      const { client, mode, controls } = context;
      const { clone, nodes } = await cloneNodes(client, 2);
      await client.dispatch(clone, nodes[0].id);
      await client.dispatch(clone, nodes[1].id);
      const first = client.expectStatus(await client.enqueue(clone, nodes[0].id), 200, "enqueue first project request");
      expectError(await client.enqueue(clone, nodes[1].id), 429, "fleet_project_cap", "enforce per-project cap");
      await claimExpected(client, { id: first.id, clone, node: nodes[0] });
      if (mode === "stub") {
        controls.advance(61);
      } else {
        const ttlMs = Number(process.env.FLEET_ADOPT_TTL_MIN ?? 20) * 60_000;
        assert(ttlMs <= client.timeoutMs, "real per-project expiry exceeds harness timeout; set FLEET_ADOPT_TTL_MIN low");
        await new Promise((resolve) => setTimeout(resolve, ttlMs + 100));
      }
      const expired = client.expectStatus(await client.getRequest(clone, first.id), 200, "sweep expired project request");
      assertEqual(expired.status, "expired", "adopted request expiry");
      const refunded = client.expectStatus(
        await client.enqueue(clone, nodes[0].id),
        200,
        "expired request permits the same node to be re-enqueued",
      );
      await claimExpected(client, { id: refunded.id, clone, node: nodes[0] });
      await finishClaim(client, refunded.id);
    },
  },
  {
    name: "daily-cap",
    stubOptions: { dailyCap: 2, perProjectCap: 1 },
    async run({ client, mode, controls, acceptedBefore = 0 }) {
      const configuredCap = mode === "stub" ? 2 : Number(process.env.FLEET_DAILY_CAP ?? 30);
      const probe = await cloneNodes(client);
      const status = client.expectStatus(await client.fleetStatus(probe.clone), 200, "read daily fleet capacity");
      assert(Number.isInteger(status.daily_remaining), "fleet status has no integer daily_remaining");
      assertEqual(
        status.daily_remaining,
        configuredCap - acceptedBefore,
        "initial daily remaining matches externally configured cap",
      );
      assert(status.daily_remaining >= 1, "daily capacity was already exhausted before the scenario");
      const accepted = [];
      for (let index = 0; index < configuredCap - acceptedBefore; index += 1) {
        const { clone, nodes } = index === 0 ? probe : await cloneNodes(client);
        const request = await dispatchAndEnqueue(client, clone, nodes[0]);
        accepted.push({ id: request.id, clone, node: nodes[0] });
      }
      const extra = await cloneNodes(client);
      await client.dispatch(extra.clone, extra.nodes[0].id);
      expectError(await client.enqueue(extra.clone, extra.nodes[0].id), 429, "fleet_daily_cap", "enforce UTC daily cap");
      for (const expected of accepted) {
        await claimExpected(client, expected);
        await finishClaim(client, expected.id);
      }
      if (mode === "stub") {
        controls.advance(12 * 60 * 60_000);
        const rollover = client.expectStatus(await client.fleetStatus(probe.clone), 200, "read capacity after UTC rollover");
        assertEqual(rollover.daily_remaining, configuredCap, "UTC rollover resets daily capacity");
        const nextDay = await cloneNodes(client);
        const request = await dispatchAndEnqueue(client, nextDay.clone, nextDay.nodes[0]);
        await claimExpected(client, { id: request.id, clone: nextDay.clone, node: nextDay.nodes[0] });
        await finishClaim(client, request.id);
      }
    },
  },
  {
    name: "FIFO-fairness",
    async run({ client }) {
      const queued = [];
      for (let index = 0; index < 3; index += 1) {
        const { clone, nodes } = await cloneNodes(client);
        const request = await dispatchAndEnqueue(client, clone, nodes[0]);
        queued.push({ id: request.id, clone, node: nodes[0] });
      }
      for (const expected of queued) {
        await claimExpected(client, expected);
        await finishClaim(client, expected.id);
      }
      assertEqual((await client.next()).status, 204, "queue is empty after ordered claims");
    },
  },
  {
    name: "TTL-expiry",
    stubOptions: { ttlMin: 0.001 },
    async run({ client, mode, controls }) {
      const first = await cloneNodes(client);
      const second = await cloneNodes(client);
      const firstRequest = await dispatchAndEnqueue(client, first.clone, first.nodes[0]);
      const secondRequest = await dispatchAndEnqueue(client, second.clone, second.nodes[0]);
      await claimExpected(client, { id: firstRequest.id, clone: first.clone, node: first.nodes[0] });
      if (mode === "stub") {
        controls.advance(61);
      } else {
        const ttlMs = Number(process.env.FLEET_ADOPT_TTL_MIN ?? 20) * 60_000;
        assert(ttlMs <= client.timeoutMs, "real adoption TTL exceeds harness timeout; set FLEET_ADOPT_TTL_MIN low");
        await new Promise((resolve) => setTimeout(resolve, ttlMs + 100));
      }
      await claimExpected(client, { id: secondRequest.id, clone: second.clone, node: second.nodes[0] });
      const expired = client.expectStatus(await client.getRequest(first.clone, firstRequest.id), 200, "read expired adopted request");
      assertEqual(expired.status, "expired", "un-heartbeated adopted request status");
      assert(typeof expired.finished_at === "string", "expired request has no finished_at timestamp");
      assert(!Object.hasOwn(expired, "outcome"), "expired request must not expose an outcome");
      await finishClaim(client, secondRequest.id);
    },
  },
  {
    name: "claim-template-mismatch",
    stubOnly: true,
    async run({ client, controls }) {
      const first = await cloneNodes(client);
      const second = await cloneNodes(client);
      const firstRequest = await dispatchAndEnqueue(client, first.clone, first.nodes[0]);
      const secondRequest = await dispatchAndEnqueue(client, second.clone, second.nodes[0]);
      controls.setNode(first.clone.project, first.nodes[0].id, { title: `Changed after enqueue ${randomUUID()}` });
      await claimExpected(client, { id: secondRequest.id, clone: second.clone, node: second.nodes[0] });
      const mismatch = client.expectStatus(
        await client.getRequest(first.clone, firstRequest.id),
        200,
        "read claim-time template mismatch",
      );
      assertEqual(mismatch.status, "failed", "claim-time template mismatch status");
      assertEqual(mismatch.outcome, "template_mismatch", "claim-time template mismatch outcome");
      await finishClaim(client, secondRequest.id);
    },
  },
  {
    name: "stale-claim",
    async run({ client, mode, controls }) {
      const first = await cloneNodes(client);
      const second = await cloneNodes(client);
      const firstRequest = await dispatchAndEnqueue(client, first.clone, first.nodes[0]);
      const secondRequest = await dispatchAndEnqueue(client, second.clone, second.nodes[0]);
      if (mode === "stub") {
        controls.invalidate(first.clone.project, first.nodes[0].id);
      } else {
        const credential = await client.workerCredential(first.clone, first.nodes[0].id);
        await client.report(first.clone, credential.token, `worker:${first.nodes[0].id}`, "WORKER_LOG", {
          node_id: first.nodes[0].id,
          lines: ["invalidate queued fleet node before claim"],
        });
      }
      await claimExpected(client, { id: secondRequest.id, clone: second.clone, node: second.nodes[0] });
      const stale = client.expectStatus(await client.getRequest(first.clone, firstRequest.id), 200, "read stale request");
      assertEqual(stale.status, "failed", "stale request status");
      assertEqual(stale.outcome, "stale", "stale request outcome");
      await finishClaim(client, secondRequest.id);
    },
  },
  {
    name: "disabled-mode",
    stubOptions: { enabled: false },
    disabled: true,
    async run({ client }) {
      const { clone, nodes } = await cloneNodes(client);
      const status = client.expectStatus(await client.fleetStatus(clone), 200, "probe disabled fleet status");
      assertEqual(status.enabled, false, "disabled fleet status enabled flag");
      assertEqual(status.queue_depth, 0, "disabled fleet queue depth");
      assertEqual(status.daily_remaining, 0, "disabled fleet daily remaining");
      assertEqual(status.project_remaining, 0, "disabled fleet project remaining");
      const calls = [
        await client.enqueue(clone, nodes[0].id),
        await client.getRequest(clone, "missing-request"),
        await client.next(),
        await client.heartbeat("missing-request"),
        await client.complete("missing-request"),
      ];
      for (const result of calls) expectError(result, 404, "fleet_disabled", "disabled fleet route");
    },
  },
];
