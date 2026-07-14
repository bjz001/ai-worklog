import type { ReactNode } from "react";

import { Icon, type IconName } from "./Icon";

export function PageHeader({
  title,
  description,
  actions
}: {
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {actions ? <div className="page-header__actions">{actions}</div> : null}
    </header>
  );
}

export function Surface({
  title,
  description,
  children,
  className = "",
  actions
}: {
  title?: string;
  description?: string;
  children: ReactNode;
  className?: string;
  actions?: ReactNode;
}) {
  return (
    <section className={`surface ${className}`.trim()}>
      {title || actions ? (
        <header className="surface__header">
          <div>
            {title ? <h2>{title}</h2> : null}
            {description ? <p>{description}</p> : null}
          </div>
          {actions ? <div className="surface__actions">{actions}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function Metric({
  label,
  value,
  helper
}: {
  label: string;
  value: ReactNode;
  helper?: string;
}) {
  return (
    <div className="metric">
      <span className="metric__label">{label}</span>
      <strong>{value}</strong>
      {helper ? <span className="metric__helper">{helper}</span> : null}
    </div>
  );
}

export function LoadingState({ rows = 4 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="正在加载" className="skeleton-list" role="status">
      {Array.from({ length: rows }, (_, index) => (
        <div className="skeleton-row" key={index}>
          <span className="skeleton skeleton--icon" />
          <span className="skeleton-row__body">
            <span className="skeleton skeleton--title" />
            <span className="skeleton skeleton--text" />
          </span>
        </div>
      ))}
    </div>
  );
}

export function ErrorState({
  error,
  onRetry
}: {
  error: Error;
  onRetry: () => void;
}) {
  return (
    <div className="state-panel state-panel--error" role="alert">
      <span className="state-panel__icon"><Icon name="error" size={28} /></span>
      <div>
        <h2>数据暂时无法加载</h2>
        <p>{error.message || "服务暂时不可用，请稍后重试。"}</p>
        <button className="button button--secondary" onClick={onRetry} type="button">
          <Icon name="refresh" />
          重新加载
        </button>
      </div>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action
}: {
  icon: IconName;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="state-panel state-panel--empty" role="status">
      <span className="state-panel__icon"><Icon name={icon} size={28} /></span>
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
        {action}
      </div>
    </div>
  );
}

export function PartialNotice({ children }: { children: ReactNode }) {
  return (
    <div className="notice notice--warning" role="status">
      <Icon name="warning" />
      <div>
        <strong>当前数据不完整</strong>
        <p>{children}</p>
      </div>
    </div>
  );
}
