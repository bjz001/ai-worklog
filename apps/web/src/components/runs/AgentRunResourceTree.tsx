import type { AgentAttachmentView } from "@ai-worklog/contracts";

import { Icon } from "@/components/ui/Icon";
import { StatusChip } from "@/components/ui/StatusChip";

import {
  attachmentStatusMeta,
  buildAgentResourceTree,
  formatByteLength,
  type AgentResourceTreeNode
} from "./agent-run-ui-model";

function ResourceNodes({ nodes }: { nodes: AgentResourceTreeNode[] }) {
  return (
    <ul>
      {nodes.map((node) => node.kind === "folder" ? (
        <li className="agent-run-resource-tree__folder" key={node.id}>
          <details open>
            <summary>
              <Icon name="folder" size={16} />
              <span>{node.name}</span>
              <small>{node.children.length} 项</small>
            </summary>
            <ResourceNodes nodes={node.children} />
          </details>
        </li>
      ) : (
        <ResourceFile key={node.id} node={node} />
      ))}
    </ul>
  );
}

function ResourceFile({ node }: { node: AgentResourceTreeNode }) {
  const attachment = node.attachment;
  if (!attachment) return null;
  const status = attachmentStatusMeta(attachment.status);
  return (
    <li className="agent-run-resource-tree__file">
      <span className="agent-run-resource-tree__file-icon"><Icon name="code" size={15} /></span>
      <span className="agent-run-resource-tree__file-copy">
        <strong>{node.name}</strong>
        <span title={node.path}>{node.path}</span>
        <small>{formatByteLength(attachment.byteLength)}{attachment.sha256 ? ` · ${attachment.sha256}` : ""}</small>
        {attachment.failureReason ? <small className="text-danger">{attachment.failureReason}</small> : null}
      </span>
      <StatusChip tone={status.tone}>{status.label}</StatusChip>
      {attachment.downloadUrl ? (
        <a
          aria-label={`下载 ${node.name}`}
          className="icon-button"
          download={attachment.filename || node.name}
          href={attachment.downloadUrl}
        >
          <Icon name="download" size={16} />
        </a>
      ) : null}
    </li>
  );
}

export function AgentRunResourceTree({
  attachments,
  rootHint
}: {
  attachments: AgentAttachmentView[];
  rootHint: string | null;
}) {
  const nodes = buildAgentResourceTree(attachments, rootHint);
  return (
    <section aria-label="已采集资源文件树" className="agent-run-resource-tree">
      <header>
        <span><Icon name="folder" size={17} /><strong>已采集资源</strong></span>
        <small>当前已加载事件 · {attachments.length} 项</small>
      </header>
      <ResourceNodes nodes={nodes} />
    </section>
  );
}
