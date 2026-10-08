import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SyncManager } from "../sync.ts";

// Regression tests for the commitMaxPendingTokens guard (hugua local patch,
// 2026-10-08). The cap used to be checked only on the turn_end path
// (commitIfNeeded); session_shutdown and session_before_compact called commit()
// directly and flushed an over-cap backlog as one oversized request, which the
// extraction model rejected with HTTP 400. commit() must self-guard now.

function config(overrides = {}) {
  return {
    commitTokenThreshold: 20000,
    commitKeepRecentCount: 10,
    captureAssistantTurns: true,
    captureToolMaxChars: 2000,
    captureMaxLength: 24000,
    takeoverEnabled: false,
    ...overrides,
  };
}

/** A client whose session always reports `pending` pending tokens. */
function client(pending) {
  const state = { commits: 0, getSession: 0 };
  return {
    state,
    connected: true,
    addMessagePayload: async () => true,
    getSession: async () => {
      state.getSession += 1;
      return { pending_tokens: pending };
    },
    commitSession: async () => ({ task_id: "t-1", archive_uri: "viking://archive/1" }),
    commitSessionResponse: async () => {
      state.commits += 1;
      return { result: { task_id: "t-1", archive_uri: "viking://archive/1" } };
    },
    fetchJSON: async () => ({ ok: true, result: {} }),
  };
}

async function withPendingDir(fn) {
  const previous = process.env.OPENVIKING_PENDING_DIR;
  const dir = await mkdtemp(join(tmpdir(), "ov-pi-pending-"));
  process.env.OPENVIKING_PENDING_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.OPENVIKING_PENDING_DIR;
    else process.env.OPENVIKING_PENDING_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

async function syncWith(pending, overrides = {}) {
  const c = client(pending);
  const sync = new SyncManager(c, config(overrides));
  await sync.ensureSession("pi-cap-session");
  return { c, sync };
}

test("commit skips and returns null when pending exceeds the cap", async () => {
  await withPendingDir(async () => {
    const { c, sync } = await syncWith(250000, { commitMaxPendingTokens: 200000 });

    assert.equal(await sync.commit(), null);
    assert.equal(c.state.commits, 0, "no oversized request may reach the server");
  });
});

test("commit proceeds at exactly the cap (guard is strictly greater-than)", async () => {
  await withPendingDir(async () => {
    const { c, sync } = await syncWith(200000, { commitMaxPendingTokens: 200000 });

    assert.notEqual(await sync.commit(), null);
    assert.equal(c.state.commits, 1);
  });
});

test("commit force overrides the cap for an explicit user command", async () => {
  await withPendingDir(async () => {
    const { c, sync } = await syncWith(3000000, { commitMaxPendingTokens: 200000 });

    assert.notEqual(await sync.commit({ force: true }), null);
    assert.equal(c.state.commits, 1);
  });
});

test("commit with pendingTokens uses the supplied count instead of re-fetching", async () => {
  await withPendingDir(async () => {
    const { c, sync } = await syncWith(250000, { commitMaxPendingTokens: 200000 });

    // The live session reports 250000 (over the cap), but the caller already
    // knows the true count is under it.
    assert.notEqual(await sync.commit({ pendingTokens: 1000 }), null);
    // Supplied 1000 is under the cap, so the commit must go through...
    assert.equal(c.state.commits, 1);
    // ...and in the skip branch above it must not have needed getSession.
    assert.equal(c.state.getSession, 0, "caller-supplied count avoids a round trip");
  });
});

test("commitIfNeeded skips over-cap backlogs on the turn_end path", async () => {
  await withPendingDir(async () => {
    const { c, sync } = await syncWith(250000, { commitMaxPendingTokens: 200000 });

    await sync.commitIfNeeded();

    assert.equal(c.state.commits, 0);
  });
});

test("commitIfNeeded commits once pending reaches the threshold under the cap", async () => {
  await withPendingDir(async () => {
    const { c, sync } = await syncWith(25000, {
      commitMaxPendingTokens: 200000,
      commitTokenThreshold: 20000,
    });

    await sync.commitIfNeeded();

    assert.equal(c.state.commits, 1);
  });
});

test("commitIfNeeded stays quiet below the commit threshold", async () => {
  await withPendingDir(async () => {
    const { c, sync } = await syncWith(5000, {
      commitMaxPendingTokens: 200000,
      commitTokenThreshold: 20000,
    });

    await sync.commitIfNeeded();

    assert.equal(c.state.commits, 0);
  });
});

test("a zero cap disables the guard", async () => {
  await withPendingDir(async () => {
    const { c, sync } = await syncWith(5000000, { commitMaxPendingTokens: 0 });

    assert.notEqual(await sync.commit(), null);
    assert.equal(c.state.commits, 1);
  });
});
