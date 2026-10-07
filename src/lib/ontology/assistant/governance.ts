// The choke point every assistant tool call goes through: permission-checked and
// audited, but READ-ONLY. There is deliberately no write path here. group_id is
// bound by the caller (the route), not chosen by the model.

import { can, defaultAuditSink, type Auth } from "../governance";
import type { SourceDocument } from "@/lib/sources/passages";
import { ASSISTANT_TOOLS, loadSources, type ToolArgs } from "./tools";

/**
 * Run one tool for a group. `sources` lets the agent loop load the group's text
 * once per turn instead of once per call.
 */
export async function governedTool(
  auth: Auth,
  toolName: string,
  args: ToolArgs,
  groupId: string,
  sources?: () => Promise<SourceDocument[]>,
): Promise<unknown> {
  const tool = ASSISTANT_TOOLS[toolName];
  const sink = defaultAuditSink();
  if (!tool) return { error: `unknown tool '${toolName}'` };
  if (!can(auth, tool.permission)) {
    await sink.write({
      agent: auth.agent,
      action: `assistant_tool:${toolName}`,
      args: { group_id: groupId, ...args },
      result: {},
      allowed: false,
      note: `missing ${tool.permission}`,
      groupId,
    });
    return { error: `permission denied: requires '${tool.permission}'` };
  }
  const docs = await (sources ? sources() : loadSources(groupId));
  const result = tool.run(docs, args);
  await sink.write({
    agent: auth.agent,
    action: `assistant_tool:${toolName}`,
    args: { group_id: groupId, ...args },
    result: { ok: !(result && typeof result === "object" && "error" in result) },
    allowed: true,
    groupId,
  });
  return result;
}
