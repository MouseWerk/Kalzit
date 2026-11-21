import { useMutation } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { Me } from "../api/auth";
import { type ErrorCode, isApiError } from "../api/client";
import { Icon } from "../components/Icon";
import { addSampleDatasource } from "../features/datasources/api";
import { useI18n } from "../i18n/i18n";
import { AccessAlert, AccessNotice } from "./AccessLayout";
import "./auth.css";

export interface SetupChoices {
  language: "de" | "en";
  theme: "system" | "light" | "dark" | "contrast";
  timeZone: string;
}

function errorCode(error: unknown): ErrorCode {
  return isApiError(error) ? error.code : "internal";
}

/**
 * The last step of setup: the owner is signed in. Three next steps as a list in the column
 * (connect a source, try the sample data, invite people; board Auth.dc.html, frame 8B), then the
 * way to Start as the one main action.
 */
export function SetupDone({ me }: { me: Me }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const org = me.orgs[0];
  const sample = useMutation({
    mutationFn: () => addSampleDatasource(org?.id ?? "", t("access.setup.done.sampleName")),
    onSuccess: async (source) => {
      await navigate({ to: "/explore", search: { source: source.id } });
    },
  });

  return (
    <div className="access__form">
      <h2 className="visually-hidden">{t("access.setup.done.next")}</h2>
      <ul className="next-list">
        <li>
          <Link to="/data-sources/new" search={{}} className="next-step">
            <span className="next-step__icon" aria-hidden="true">
              <Icon name="dataSources" />
            </span>
            <span className="next-step__title">{t("access.setup.done.sourceTitle")}</span>
            <span className="next-step__text">{t("access.setup.done.sourceText")}</span>
            <span className="next-step__go" aria-hidden="true">
              <Icon name="arrowRight" />
            </span>
          </Link>
        </li>
        <li>
          <button
            type="button"
            className="next-step"
            aria-disabled={sample.isPending}
            onClick={() => {
              if (!sample.isPending) {
                sample.mutate();
              }
            }}
          >
            <span className="next-step__icon" aria-hidden="true">
              <Icon name="explore" />
            </span>
            <span className="next-step__title">{t("access.setup.done.sampleTitle")}</span>
            <span className="next-step__text">
              {sample.isPending
                ? t("access.setup.done.sampleBusy")
                : t("access.setup.done.sampleText")}
            </span>
            <span className="next-step__go" aria-hidden="true">
              {sample.isPending ? <span className="access__spinner" /> : <Icon name="arrowRight" />}
            </span>
          </button>
        </li>
        <li>
          <Link to="/admin/members" className="next-step">
            <span className="next-step__icon" aria-hidden="true">
              <Icon name="members" />
            </span>
            <span className="next-step__title">{t("access.setup.done.inviteTitle")}</span>
            <span className="next-step__text">{t("access.setup.done.inviteText")}</span>
            <span className="next-step__go" aria-hidden="true">
              <Icon name="arrowRight" />
            </span>
          </Link>
        </li>
      </ul>
      <AccessAlert>
        {sample.error === null ? null : (
          <AccessNotice tone="danger" icon="alert" title={t(`errors.${errorCode(sample.error)}`)} />
        )}
      </AccessAlert>
      <Link to="/" className="button button--primary button--block access__submit">
        {t("access.setup.done.toStart")}
      </Link>
    </div>
  );
}
