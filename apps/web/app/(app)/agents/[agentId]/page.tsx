"use client";

import { useParams } from "next/navigation";
import { AgentEditor } from "@/components/agent-editor/agent-editor";

export default function AgentEditorPage() {
  const { agentId } = useParams<{ agentId: string }>();
  return <AgentEditor key={agentId} agentId={agentId} />;
}
