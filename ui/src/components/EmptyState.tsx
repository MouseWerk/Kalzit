import { type ReactNode, useId } from "react";
import { Icon, type IconName } from "./Icon";

interface EmptyStateProps {
  icon: IconName;
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}

export function EmptyState({ icon, title, children, actions }: EmptyStateProps) {
  const titleId = useId();
  return (
    <section className="empty-state" aria-labelledby={titleId}>
      <div className="empty-state__icon">
        <Icon name={icon} />
      </div>
      <h2 className="empty-state__title" id={titleId}>
        {title}
      </h2>
      <p className="empty-state__text">{children}</p>
      {actions === undefined ? null : <div className="empty-state__actions">{actions}</div>}
    </section>
  );
}
