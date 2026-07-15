import type { PromptView } from "@ai-worklog/contracts";

import {
  formatDateTime,
  formatSource
} from "@/lib/presenters";

export function PromptDetailContent({ prompt }: { prompt: PromptView }) {
  return (
    <div className="stack">
      <section className="drawer-section">
        <h3>用户 Prompt</h3>
        <p className="prompt-content">{prompt.content}</p>
      </section>
      <section className="drawer-section">
        <h3>可见结果</h3>
        <p>{prompt.resultExcerpt ?? "这条 Prompt 没有关联的可见结果摘要。"}</p>
      </section>
      <section className="drawer-section">
        <h3>来源信息</h3>
        <dl className="definition-list">
          <dt>来源</dt><dd>{formatSource(prompt.sourceType)}</dd>
          <dt>设备</dt><dd>{prompt.deviceName}</dd>
          <dt>工作日期</dt><dd>{prompt.workDate}</dd>
          <dt>记录时间</dt><dd>{formatDateTime(prompt.occurredAt)}</dd>
          <dt>Prompt ID</dt><dd>{prompt.id}</dd>
        </dl>
      </section>
      {prompt.tags.length > 0 ? (
        <section className="drawer-section">
          <h3>标签</h3>
          <div className="tag-list">
            {prompt.tags.map((tag) => <span className="tag" key={tag}>{tag}</span>)}
          </div>
        </section>
      ) : null}
    </div>
  );
}
