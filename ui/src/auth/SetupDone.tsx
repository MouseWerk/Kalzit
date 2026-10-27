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
 * The last step of setup: the owner is signed in. The next steps as tiles (connect a source, try
 * the sample data, invite people), a summary of what was set up and the way to Start.
 */
export function SetupDone({ me, choices }: { me: Me; choices: SetupChoices }) {
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
    <div className="access__card setup-done">
      <h2 className="visually-hidden">{t("access.setup.done.next")}</h2>
      <div className="setup-done__tiles">
        <Link to="/data-sources/new" search={{}} className="next-tile next-tile--lead">
          <span className="next-tile__icon">
            <Icon name="database" />
          </span>
          <h3>{t("access.setup.done.sourceTitle")}</h3>
          <p>{t("access.setup.done.sourceText")}</p>
          <span className="next-tile__go">
            {t("access.setup.done.sourceGo")}
            <Icon name="arrowRight" />
          </span>
        </Link>
        <button
          type="button"
          className="next-tile"
          aria-disabled={sample.isPending}
          onClick={() => {
            if (!sample.isPending) {
              sample.mutate();
            }
          }}
        >
          <span className="next-tile__icon">
            <Icon name="explore" />
          </span>
          <h3>{t("access.setup.done.sampleTitle")}</h3>
          <p>{t("access.setup.done.sampleText")}</p>
          <span className="next-tile__go">
            {sample.isPending ? (
              <>
                <span className="access__spinner" aria-hidden="true" />
                {t("access.setup.done.sampleBusy")}
              </>
            ) : (
              <>
                {t("access.setup.done.sampleGo")}
                <Icon name="arrowRight" />
              </>
            )}
          </span>
        </button>
        <Link to="/admin/members" className="next-tile">
          <span className="next-tile__icon">
            <Icon name="members" />
          </span>
          <h3>{t("access.setup.done.inviteTitle")}</h3>
          <p>{t("access.setup.done.inviteText")}</p>
          <span className="next-tile__go">
            {t("access.setup.done.inviteGo")}
            <Icon name="arrowRight" />
          </span>
        </Link>
      </div>
      <AccessAlert>
        {sample.error === null ? null : (
          <AccessNotice tone="danger" icon="alert" title={t(`errors.${errorCode(sample.error)}`)} />
        )}
      </AccessAlert>
      <div className="setup-done__foot">
        <dl className="setup-done__summary">
          <dt>{t("access.setup.done.org")}</dt>
          <dd>{org?.name}</dd>
          <dt>{t("access.setup.done.owner")}</dt>
          <dd>
            {me.name} · {me.email}
          </dd>
          <dt>{t("access.setup.done.defaults")}</dt>
          <dd>
            {t("access.setup.done.defaultsValue", {
              language: t(`language.${choices.language}`),
              theme: t(`theme.${choices.theme}`),
              zone: choices.timeZone,
            })}
          </dd>
        </dl>
        <Link to="/" className="button button--secondary">
          {t("access.setup.done.toStart")}
          <Icon name="arrowRight" />
        </Link>
      </div>
      <p className="setup-done__note">
        <Icon name="check" />
        <span>{t("access.setup.done.codeDeleted")}</span>
      </p>
    </div>
  );
}
