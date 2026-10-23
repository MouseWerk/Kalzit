import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { Icon } from "../components/Icon";
import { useI18n } from "../i18n/i18n";
import { dismissSetup, isSetupDismissed, useSetupSteps } from "./setupSteps";
import "./shellUx.css";

/**
 * A card with the organization's first steps: add a data source, create a dashboard, invite a
 * colleague. Each step is checked from real data; the card leaves once all are done or when the
 * user hides it. It sits at the bottom of the sidebar, or on the start page where the sidebar is
 * a bar on top.
 */
export function SetupChecklist({
  userId,
  orgId,
  placement,
}: {
  userId: string;
  orgId: string;
  placement: "sidebar" | "page";
}) {
  const { t } = useI18n();
  const titleId = useId();
  const [dismissed, setDismissed] = useState(() => isSetupDismissed(userId, orgId));
  const { steps } = useSetupSteps(orgId);
  if (dismissed || steps === undefined || steps.length === 0) {
    return null;
  }
  const done = steps.filter((step) => step.done).length;
  const next = steps.find((step) => !step.done);
  if (next === undefined) {
    return null;
  }

  function dismiss() {
    dismissSetup(userId, orgId);
    setDismissed(true);
  }

  return (
    <section className={`setup setup--${placement}`} aria-labelledby={titleId}>
      <div className="setup__header">
        <span className="setup__tile" aria-hidden="true">
          <Icon name="checklist" />
        </span>
        <button
          type="button"
          className="setup__close"
          aria-label={t("shell.setup.dismiss")}
          title={t("shell.setup.dismiss")}
          onClick={dismiss}
        >
          <Icon name="close" />
        </button>
      </div>
      <h2 id={titleId} className="setup__title">
        {t("shell.setup.title")}
      </h2>
      <p className="setup__progress">{t("shell.setup.progress", { done, total: steps.length })}</p>
      <ul className="setup__steps">
        {steps.map((step) => (
          <li key={step.key} className="setup__step" data-done={step.done ? "" : undefined}>
            <span className="setup__mark" aria-hidden="true">
              {step.done ? <Icon name="check" /> : null}
            </span>
            <span className="setup__label">
              {t(step.label)}
              <span className="visually-hidden">
                {t(step.done ? "shell.setup.stepDone" : "shell.setup.stepOpen")}
              </span>
            </span>
          </li>
        ))}
      </ul>
      <Link
        to={next.to}
        search={next.search ?? {}}
        className="button button--secondary setup__action"
      >
        {t(next.action)}
      </Link>
    </section>
  );
}
