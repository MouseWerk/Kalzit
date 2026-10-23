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
  /**
   * Drawing is tried again when any of these changes (compared one by one): the data, the
   * panel type, its options.
   */
  resetKeys: readonly unknown[];
  children: ReactNode;
}

interface State {
  failed: boolean;
  keys: readonly unknown[];
}

const sameKeys = (a: readonly unknown[], b: readonly unknown[]) =>
  a.length === b.length && a.every((value, i) => Object.is(value, b[i]));

/**
 * Keeps a panel that fails while drawing (a renderer that cannot start, odd data) inside its own
 * card: the panel says so, and the rest of the dashboard or Explore stays as it is.
 */
export class PanelErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false, keys: this.props.resetKeys };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return sameKeys(props.resetKeys, state.keys) ? null : { failed: false, keys: props.resetKeys };
  }

  override render(): ReactNode {
    return this.state.failed ? <PanelFailed /> : this.props.children;
  }
}
