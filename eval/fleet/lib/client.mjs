import { randomUUID } from "node:crypto";

export class HarnessError extends Error {
  constructor(message, details = undefined) {
    super(message);
    this.name = "HarnessError";
    this.details = details;
  }
}

export function assert(condition, message, details = undefined) {
  if (!condition) throw new HarnessError(message, details);
}

export function assertEqual(actual, expected, message) {
  assert(
    Object.is(actual, expected),
    `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

export class FleetClient {
  constructor(baseUrl, { reporterToken, timeoutMs = 120_000 } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.reporterToken = reporterToken;
    this.timeoutMs = timeoutMs;
    this.capabilities = new Set();
    this.responses = [];
    this.fleetResponses = [];
    this.clones = [];
  }

  async request(method, path, { headers = {}, body, fleet = false, allowCapability = false } = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed;
    if (text !== "") {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    const result = { status: response.status, body: parsed };
    this.responses.push({ path, text, allowCapability });
    if (this.reporterToken) {
      assert(!text.includes(this.reporterToken), `${path} leaked the supervisor token`);
    }
    if (fleet) {
      this.fleetResponses.push({ path, status: response.status, text });
      this.assertFleetResponseSafe(path, text);
    }
    return result;
  }

  expectStatus(result, status, label) {
    assertEqual(result.status, status, label);
    return result.body;
  }

  assertFleetResponseSafe(path, text) {
    const forbidden = [this.reporterToken, ...this.capabilities].filter(Boolean);
    for (const secret of forbidden) {
      assert(!text.includes(secret), `${path} leaked a supervisor token or raw human capability`);
    }
    assert(!/"(?:reporter_token|supervisor_token|capability)"\s*:/i.test(text), `${path} exposed a privileged credential field`);
  }

  assertAllFleetResponsesSafe() {
    for (const response of this.fleetResponses) this.assertFleetResponseSafe(response.path, response.text);
  }

  assertAllResponsesSafe() {
    this.assertAllFleetResponsesSafe();
    for (const response of this.responses) {
      if (this.reporterToken) {
        assert(!response.text.includes(this.reporterToken), `${response.path} leaked the supervisor token`);
      }
      for (const capability of this.capabilities) {
        if (!response.allowCapability) {
          assert(!response.text.includes(capability), `${response.path} leaked a raw human capability`);
        }
      }
    }
  }

  async clone() {
    const result = await this.request("POST", "/api/clone-demo");
    const body = this.expectStatus(result, 200, "clone seed");
    assert(typeof body?.project === "string" && typeof body?.token === "string", "clone response is missing project/token");
    const clone = { project: body.project, token: body.token };
    this.clones.push(clone);
    return clone;
  }

  async snapshot(clone) {
    const result = await this.request("GET", `/api/p/${encodeURIComponent(clone.project)}/snapshot`, {
      headers: { "x-mg-token": clone.token },
    });
    return this.expectStatus(result, 200, "read clone snapshot");
  }

  async exportLedger(clone) {
    const result = await this.request("GET", `/api/p/${encodeURIComponent(clone.project)}/export`, {
      headers: { "x-mg-token": clone.token },
    });
    const body = this.expectStatus(result, 200, "read clone ledger");
    assert(Array.isArray(body?.events), "ledger response is missing events");
    for (const event of body.events) {
      assertEqual(event.project_id, clone.project, "clone ledger contains a foreign-project event");
    }
    return body.events;
  }

  async assertCloneLedgersIsolated() {
    for (const clone of this.clones) await this.exportLedger(clone);
  }

  async mutation(clone, type, payload) {
    const result = await this.request("POST", `/api/p/${encodeURIComponent(clone.project)}/mutations`, {
      headers: { "x-mg-token": clone.token },
      body: { type, payload, idem_key: `fleet-eval-${randomUUID()}` },
    });
    return this.expectStatus(result, 200, `append ${type}`);
  }

  async dispatch(clone, nodeId, { briefOverride } = {}) {
    const mutation = {
      type: "DISPATCHED",
      payload: {
        node_id: nodeId,
        bypass_cap: true,
        ...(briefOverride === undefined ? {} : { brief_override: briefOverride }),
      },
    };
    const sessionResult = await this.request("POST", `/api/p/${encodeURIComponent(clone.project)}/browser-sessions`, {
      headers: { "x-mg-token": clone.token },
    });
    const session = this.expectStatus(sessionResult, 200, "issue browser session");
    const sessionHeaders = {
      "x-mg-token": clone.token,
      "x-mg-session": session.session_id,
      "x-mg-session-proof": session.session_proof,
    };
    const draftResult = await this.request("POST", `/api/p/${encodeURIComponent(clone.project)}/action-drafts`, {
      headers: sessionHeaders,
      body: { mutation, summary: `Dispatch ${nodeId} for fleet evaluation.` },
    });
    const draft = this.expectStatus(draftResult, 200, "stage dispatch action draft");
    const confirmResult = await this.request(
      "POST",
      `/api/p/${encodeURIComponent(clone.project)}/action-drafts/${encodeURIComponent(draft.draft_id)}/confirm`,
      { headers: sessionHeaders, allowCapability: true },
    );
    const capability = this.expectStatus(confirmResult, 200, "confirm dispatch action draft");
    assert(typeof capability?.capability === "string", "action confirmation did not return a capability");
    this.capabilities.add(capability.capability);
    const result = await this.request("POST", `/api/p/${encodeURIComponent(clone.project)}/mutations`, {
      headers: {
        ...sessionHeaders,
        "x-mg-capability-ref": capability.capability_ref,
        "x-mg-capability": capability.capability,
        "x-mg-nonce": randomUUID(),
      },
      body: { ...mutation, idem_key: `fleet-eval-dispatch-${randomUUID()}` },
    });
    return this.expectStatus(result, 200, "append confirmed DISPATCHED");
  }

  async addTask(clone, { title, brief, estimate = 1 }) {
    const id = `fleet-eval-${randomUUID()}`;
    await this.mutation(clone, "TASK_ADDED", {
      node: { id, title, brief, estimate_min: estimate, tags: ["fleet-eval"], state: "queued" },
    });
    return id;
  }

  async fleetStatus(clone) {
    return this.request("GET", `/api/p/${encodeURIComponent(clone.project)}/fleet-status`, {
      headers: { "x-mg-token": clone.token },
      fleet: true,
    });
  }

  async enqueue(clone, nodeId) {
    return this.request("POST", `/api/p/${encodeURIComponent(clone.project)}/fleet-requests`, {
      headers: { "x-mg-token": clone.token },
      body: { node_id: nodeId },
      fleet: true,
    });
  }

  async getRequest(clone, requestId) {
    return this.request(
      "GET",
      `/api/p/${encodeURIComponent(clone.project)}/fleet-requests/${encodeURIComponent(requestId)}`,
      { headers: { "x-mg-token": clone.token }, fleet: true },
    );
  }

  async next() {
    return this.request("POST", "/api/fleet/next", {
      headers: { "x-mg-reporter": this.reporterToken },
      fleet: true,
    });
  }

  async heartbeat(requestId) {
    return this.request("POST", `/api/fleet/${encodeURIComponent(requestId)}/heartbeat`, {
      headers: { "x-mg-reporter": this.reporterToken },
      fleet: true,
    });
  }

  async complete(requestId, outcome = "done", note = undefined) {
    return this.request("POST", `/api/fleet/${encodeURIComponent(requestId)}/complete`, {
      headers: { "x-mg-reporter": this.reporterToken },
      body: { outcome, ...(note === undefined ? {} : { note }) },
      fleet: true,
    });
  }

  async workerCredential(clone, nodeId) {
    const result = await this.request("POST", `/api/p/${encodeURIComponent(clone.project)}/reporter-credentials`, {
      headers: { authorization: `Bearer ${this.reporterToken}` },
      body: { actor: `worker:${nodeId}` },
    });
    return this.expectStatus(result, 200, "mint node-bound worker credential");
  }

  async report(clone, token, actor, type, payload) {
    const result = await this.request("POST", `/api/p/${encodeURIComponent(clone.project)}/report`, {
      headers: { authorization: `Bearer ${token}` },
      body: { actor, type, payload, idem_key: `fleet-eval-report-${randomUUID()}` },
    });
    return this.expectStatus(result, 200, `report ${type}`);
  }

  async waitFor(label, probe, predicate, { timeoutMs = this.timeoutMs, intervalMs = 100 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() <= deadline) {
      last = await probe();
      if (predicate(last)) return last;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new HarnessError(`timed out waiting for ${label}`, { last });
  }
}

export function taskNodes(snapshot) {
  return Object.values(snapshot?.state?.nodes ?? {}).filter((node) => node.record_type === "task");
}
