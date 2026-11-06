import type { ReactNode } from "react";
import { Icon, type IconName } from "../../components/Icon";
import { useI18n } from "../../i18n/i18n";
import { usePanelHost } from "../host";
import "./graph.css";

/**
 * A state in place of a graph (Graph board, frame 3): an empty result or one too large to lay
 * out, with what to do about it. "Edit query" leads to the panel editor for those who may edit
 * the dashboard; `actions` come before it. An empty state keeps the `panel-empty` class every
 * panel's empty state has.
 */
export function GraphState({
  icon,
  children,
  actions,
  empty = false,
}: {
  icon: IconName;
  children: ReactNode;
  actions?: ReactNode;
  empty?: boolean;
}) {
  const { t } = useI18n();
  const { editQuery } = usePanelHost();
  const any = actions !== undefined || editQuery !== undefined;
  return (
    <div className={empty ? "graph__state panel-empty" : "graph__state"}>
      <span className="graph__state-icon" aria-hidden="true">
        <Icon name={icon} />
      </span>
      <p className="graph__state-text" role="status">
        {children}
      </p>
      {any ? (
        <div className="graph__state-actions">
          {actions}
          {editQuery === undefined ? null : (
            <button
              type="button"
              className="button button--secondary button--small"
              onClick={editQuery}
            >
              {t("graph.editQuery")}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
