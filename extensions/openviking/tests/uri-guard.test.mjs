import test from "node:test"
import assert from "node:assert/strict"
import { guardVikingUriToolCall } from "../lib/uri-guard-adapter.mjs"

// LOCAL PATCH (hugua): mirrors uri-guard-adapter.mjs — read/edit/grep/find/ls
// guarded, but only on path-concept params; bash unguarded for ov CLI ops.

test("pi URI guard blocks builtin file tools on viking URIs", () => {
  const decision = guardVikingUriToolCall({
    type: "tool_call",
    toolName: "read",
    input: { path: "viking://resources/project/file.md" },
  })

  assert.equal(decision?.block, true)
  assert.match(decision?.reason ?? "", /viking:\/\/ URIs are OpenViking virtual paths/)
  assert.match(decision?.reason ?? "", /Use viking_read instead/)
})

test("pi URI guard blocks edit on viking URIs", () => {
  const decision = guardVikingUriToolCall({
    type: "tool_call",
    toolName: "edit",
    input: { path: "viking://resources/project/file.md", edits: [] },
  })

  assert.equal(decision?.block, true)
  assert.match(decision?.reason ?? "", /viking:\/\/ URIs are OpenViking virtual paths/)
  assert.match(decision?.reason ?? "", /Use viking_read \(read\) or memwrite \(write\) instead/)
})

test("pi URI guard blocks grep/find/ls when the PATH param is a viking URI", () => {
  const grep = guardVikingUriToolCall({
    type: "tool_call",
    toolName: "grep",
    input: { pattern: "recall", path: "viking://user/memories" },
  })
  assert.equal(grep?.block, true)
  assert.match(grep?.reason ?? "", /Use viking_search instead/)
  assert.match(grep?.reason ?? "", /viking_search\(query="recall", scope="viking:\/\/user\/memories"\)/)

  const find = guardVikingUriToolCall({
    type: "tool_call",
    toolName: "find",
    input: { pattern: "*.md", path: "viking://resources" },
  })
  assert.equal(find?.block, true)
  assert.match(find?.reason ?? "", /Use viking_browse instead/)

  const ls = guardVikingUriToolCall({
    type: "tool_call",
    toolName: "ls",
    input: { path: "viking://resources" },
  })
  assert.equal(ls?.block, true)
  assert.match(ls?.reason ?? "", /Use viking_browse instead/)
})

test("pi URI guard ignores viking URIs in non-path params (pattern is content, not a path)", () => {
  // searching for the literal string "viking://" in a local file must not block
  assert.equal(guardVikingUriToolCall({
    type: "tool_call",
    toolName: "grep",
    input: { pattern: "viking://", path: "/home/user/notes.md" },
  }), null)

  assert.equal(guardVikingUriToolCall({
    type: "tool_call",
    toolName: "find",
    input: { pattern: "viking://*", path: "/tmp" },
  }), null)

  // URI in an unrelated/unknown param must not block either
  assert.equal(guardVikingUriToolCall({
    type: "tool_call",
    toolName: "ls",
    input: { label: "docs viking://resources", path: "/tmp" },
  }), null)
})

test("pi URI guard allows bash commands containing viking URIs (ov CLI ops)", () => {
  // bash is deliberately unguarded so `ov read viking://...` etc. work.
  assert.equal(guardVikingUriToolCall({
    type: "tool_call",
    toolName: "bash",
    input: { command: "ov read viking://resources/project/file.md" },
  }), null)
})

test("pi URI guard allows normal local paths and OpenViking native tools", () => {
  assert.equal(guardVikingUriToolCall({ toolName: "read", input: { path: "/tmp/file.md" } }), null)
  assert.equal(guardVikingUriToolCall({ toolName: "viking_read", input: { uri: "viking://resources/file.md" } }), null)
})
