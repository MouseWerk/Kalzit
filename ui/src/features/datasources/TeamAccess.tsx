import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { IconButton } from "../../components/IconButton";
import { Select } from "../../components/Select";
import { useI18n } from "../../i18n/i18n";
import { showErrorToast, showToast } from "../../lib/toasts";
import { useOrgPermissions } from "../../org/useOrg";
import {
  addGrant,
  adminKeys,
  type Grant,
  type GrantLevel,
  levelsFor,
  listTeams,
  MAX_PAGE_SIZE,
  removeGrant,
} from "../admin/api";
import { LEVEL_TEXT } from "../admin/catalog";
import { usePagedList } from "../admin/components/lists";
import { errorText, GRANT_ERRORS } from "../admin/errors";
import { DATASOURCES_KEY, type DatasourceSummary } from "./api";
import { initials } from "./listCells";
import "./datasources.css";

/**
 * The teams a source is shared with, each with its level as a choice: a change applies at once and
 * the toast offers Undo, as settings do. The server checks each change (the caller must hold what
 * they give or take away) and audits it.
 */
export function TeamAccess({
  orgId,
  source,
  grants,
}: {
  orgId: string;
  source: Pick<DatasourceSummary, "id" | "name">;
  /** The source's team grants, from the access list the caller may read. */
  grants: readonly Grant[];
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const permissions = useOrgPermissions();
  const headingId = useId();
  const addId = useId();
  const levels = levelsFor("datasource");
  const [busy, setBusy] = useState(false);
  const canPick = permissions.has("teams:read");
  const teams = usePagedList(
    [...adminKeys.teams(orgId), "picker"],
    (cursor) => listTeams(orgId, cursor, MAX_PAGE_SIZE),
    canPick,
  );
  const granted = new Set(grants.map((grant) => grant.subjectId));
  const addable = (teams.items ?? []).filter((team) => !granted.has(team.id));

  async function refresh() {
    await queryClient.invalidateQueries({
      queryKey: adminKeys.grants(orgId, "datasource", source.id),
    });
    await queryClient.invalidateQueries({ queryKey: [DATASOURCES_KEY, orgId] });
  }

  /** Runs one change; the toast says what changed and how to take it back. */
  async function apply(
    change: () => Promise<unknown>,
    message: string,
    undo: () => Promise<unknown>,
  ) {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      await change();
      await refresh();
      showToast({
        message,
        undo: () => {
          undo()
            .then(refresh)
            .then(() => showToast({ message: t("datasources.access.undone") }))
            .catch((error: unknown) => showErrorToast(errorText(t, error, GRANT_ERRORS)));
        },
      });
    } catch (error) {
      showErrorToast(errorText(t, error, GRANT_ERRORS));
    } finally {
      setBusy(false);
    }
  }

  const grantInput = (teamId: string, level: GrantLevel) => ({
    subjectType: "team" as const,
    subjectId: teamId,
    resourceType: "datasource" as const,
    resourceId: source.id,
    level,
  });

  function changeLevel(grant: Grant, level: GrantLevel) {
    if (level === grant.level) {
      return;
    }
    void apply(
      () => addGrant(orgId, grantInput(grant.subjectId, level)),
      t("datasources.access.changed", { name: grant.subjectName, level: t(LEVEL_TEXT[level]) }),
      () => addGrant(orgId, grantInput(grant.subjectId, grant.level)),
    );
  }

  function remove(grant: Grant) {
    void apply(
      () => removeGrant(orgId, grant.id),
      t("datasources.access.removed", { name: grant.subjectName }),
      () => addGrant(orgId, grantInput(grant.subjectId, grant.level)),
    );
  }

  function add(teamId: string) {
    const team = addable.find((candidate) => candidate.id === teamId);
    if (team === undefined) {
      return;
    }
    let created: Grant | undefined;
    void apply(
      async () => {
        created = await addGrant(orgId, grantInput(team.id, "query"));
      },
      t("datasources.access.added", { name: team.name }),
      async () => {
        if (created !== undefined) {
          await removeGrant(orgId, created.id);
        }
      },
    );
  }

  return (
    <section className="ds-team-access" aria-labelledby={headingId}>
      <h3 id={headingId} className="ds-drawer__section">
        {grants.length === 1
          ? t("datasources.access.teamsOne")
          : t("datasources.access.teams", { count: grants.length })}
      </h3>
      {grants.length === 0 ? (
        <p className="ds-drawer__empty">{t("datasources.access.noTeams")}</p>
      ) : (
        <ul className="ds-grants">
          {grants.map((grant) => (
            <li key={grant.id} className="ds-grants__row">
              <span className="ds-grants__initials" aria-hidden="true">
                {initials(grant.subjectName)}
              </span>
              <span className="ds-grants__who">
                <span className="ds-grants__name">{grant.subjectName}</span>
              </span>
              <Select
                className="ds-grants__select"
                aria-label={t("datasources.access.levelFor", { name: grant.subjectName })}
                value={grant.level}
                disabled={busy}
                onChange={(next) => {
                  const level = levels.find((candidate) => candidate === next);
                  if (level !== undefined) {
                    changeLevel(grant, level);
                  }
                }}
              >
                {levels.map((level) => (
                  <option key={level} value={level}>
                    {t(LEVEL_TEXT[level])}
                  </option>
                ))}
              </Select>
              <IconButton
                icon="close"
                label={t("datasources.access.remove", { name: grant.subjectName })}
                disabled={busy}
                onClick={() => remove(grant)}
              />
            </li>
          ))}
        </ul>
      )}
      {canPick && addable.length > 0 ? (
        <div className="ds-team-access__add">
          <label className="visually-hidden" htmlFor={addId}>
            {t("datasources.access.add")}
          </label>
          <Select id={addId} value="" disabled={busy} onChange={add}>
            <option value="">{t("datasources.access.add")}</option>
            {addable.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </Select>
        </div>
      ) : null}
    </section>
  );
}
