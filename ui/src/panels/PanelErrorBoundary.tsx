import { Component, type ReactNode } from "react";
import { Icon } from "../components/Icon";
import { useI18n } from "../i18n/i18n";
import "./panels.css";

function PanelFailed() {
  const { t } = useI18n();
  return (
    <div className="panel-error" role="alert">
      <Icon name="alert" />
      <span>{t("dashboards.panel.drawFailed")}</span>
    </div>
  );
}

interface Props {
  /** A new value (other data, another panel type) tries drawing again. */
  resetKey: unknown;
  children: ReactNode;
}

interface State {
  failed: boolean;
  key: unknown;
}

/**
 * Keeps a panel that fails while drawing (a renderer that cannot start, odd data) inside its own
 * card: the panel says so, and the rest of the dashboard or Explore stays as it is.
 */
export class PanelErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false, key: this.props.resetKey };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey === state.key ? null : { failed: false, key: props.resetKey };
  }

  override render(): ReactNode {
    return this.state.failed ? <PanelFailed /> : this.props.children;
  }
}
