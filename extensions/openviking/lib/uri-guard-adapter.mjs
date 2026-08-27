import { buildGuardMessage, findVikingUriInValue, normalizeToolName } from "../shared/uri-guard.mjs";

// LOCAL PATCH (hugua, 2026-08-24): upstream guards read/grep/find/ls/bash and
// matches viking:// in ANY argument (shared/uri-guard.mjs findVikingUri falls
// back to scanning the whole input object, so even grep pattern="viking://"
// or a bash command mentioning a URI gets blocked). Two changes here:
//   1. bash is unguarded — `ov read viking://...` / `ov reindex viking://...`
//      CLI ops go through bash and were all blocked, making OV ops painful.
//   2. read/edit/grep/find/ls trigger ONLY on path-concept params, so
//      content-like params (grep's pattern, etc.) never block — searching for
//      the literal string "viking://" in local files keeps working.
// Re-apply after reinstalling the upstream extension (install.sh --harness pi
// overwrites this file).

/** Path-concept params only — deliberately excludes "pattern" (content, not path). */
const PATH_PARAM_KEYS = [
  "path",
  "filePath",
  "file_path",
  "filepath",
  "dir",
  "directory",
  "uri",
  "targetUri",
  "target_uri",
];

const VIKING_URI_TOOL_HINTS = {
  read: {
    tool: "viking_read",
    example: (uri) => `viking_read(uri="${uri}", level="overview")`,
  },
  edit: {
    // viking:// content is not a local file; reads go through viking_read,
    // writes through memwrite (openviking-memory extension) or viking_remember.
    tool: "viking_read (read) or memwrite (write)",
    example: (uri) => `memwrite(uri="${uri}", content="...", mode="replace")`,
  },
  grep: {
    tool: "viking_search",
    example: (uri, input = {}) => `viking_search(query="${String(input.pattern ?? "").replaceAll('"', '\\"')}", scope="${uri}")`,
  },
  find: {
    tool: "viking_browse",
    example: (uri) => `viking_browse(action="list", uri="${uri}")`,
  },
  ls: {
    tool: "viking_browse",
    example: (uri) => `viking_browse(action="list", uri="${uri}")`,
  },
};

/** Scan only path-concept params for a viking:// URI; never scan content params. */
function findVikingUriInPathParams(input) {
  if (!input || typeof input !== "object") return null;
  for (const key of PATH_PARAM_KEYS) {
    const uri = findVikingUriInValue(input[key]);
    if (uri) return uri;
  }
  return null;
}

export function guardVikingUriToolCall(event) {
  const toolName = normalizeToolName(event?.toolName ?? event?.tool_name ?? event?.name);
  const hint = VIKING_URI_TOOL_HINTS[toolName];
  if (!hint) return null;

  const input = event?.input ?? event?.args ?? event?.params ?? {};
  const uri = findVikingUriInPathParams(input);
  if (!uri) return null;

  return {
    block: true,
    reason: buildGuardMessage(uri, {
      tool: hint.tool,
      example: hint.example(uri, input),
    }),
  };
}
