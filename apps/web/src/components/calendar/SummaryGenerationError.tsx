import { Icon } from "@/components/ui/Icon";
import { summaryGenerationErrorCopy } from "./summary-prompt-editor-model";

export function SummaryGenerationError({ error }: { error: unknown }) {
  const copy = summaryGenerationErrorCopy(error);
  return (
    <div
      className="form-feedback form-feedback--error summary-generation-error"
      role="alert"
    >
      <Icon name="error" />
      <span>
        <strong>{copy.title}</strong>
        <small>{copy.guidance}</small>
        {copy.requestId ? <small>请求 ID：{copy.requestId}</small> : null}
      </span>
    </div>
  );
}
