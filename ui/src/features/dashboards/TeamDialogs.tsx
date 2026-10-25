import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { FormAlert } from "../../components/FormAlert";
import { TextField } from "../../components/TextField";
import { useI18n } from "../../i18n/i18n";
import { TEAM_CONTEXT_KEY, type TeamChoice, useTeamContext } from "../../org/teamContext";
import { useOrgPermissions } from "../../org/useOrg";
import {
  createTeamSpace,
  DASHBOARDS_KEY,
  FOLDERS_KEY,
  type OwnerTeam,
  setOwner,
  type Visibility,
} from "./api";
import "./dashboardTools.css";
import { Dialog } from "./ui/Dialog";
import { errorMessage } from "./ui/errors";

/**
 * The teams the caller may create a team space for: those they maintain, every team for org
 * admins (the server checks the same).
 */
export function spaceTeams(teams: readonly TeamChoice[], orgAdmin: boolean): TeamChoice[] {
  return teams.filter((team) => orgAdmin || team.maintainer);
}

/** "Create team space": a name and the team; the space opens once it exists. */
export function TeamSpaceDialog({
  orgId,
  onClose,
  onCreated,
}: {
  orgId: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { t } = useI18n();
  const permissions = useOrgPermissions();
  const { context, team: active } = useTeamContext();
  const teams = spaceTeams(context.teams, permissions.has("folders:permissions"));
  const first = teams.find((team) => team.id === active?.id) ?? teams[0];
  const [teamId, setTeamId] = useState(first?.id ?? "");
  const [name, setName] = useState(first?.name ?? "");
  const [error, setError] = useState<string | undefined>(undefined);
  const queryClient = useQueryClient();
  const formId = useId();
  const selectId = useId();
  const create = useMutation({
    mutationFn: () => createTeamSpace(orgId, { name: name.trim(), ownerTeamId: teamId }),
    onSuccess: async ({ id }) => {
      await queryClient.invalidateQueries({ queryKey: [FOLDERS_KEY, orgId] });
      await queryClient.invalidateQueries({ queryKey: [TEAM_CONTEXT_KEY, orgId] });
      onClose();
      onCreated(id);
    },
  });
  return (
    <Dialog
      title={t("dashboards.team.newSpaceTitle")}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="button button--secondary" onClick={onClose}>
            {t("dashboards.dialog.cancel")}
          </button>
          <button
            type="submit"
            form={formId}
            className="button button--primary"
            disabled={create.isPending || teamId === ""}
          >
            {t("dashboards.team.newSpaceCreate")}
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() === "") {
            setError(t("dashboards.folders.nameRequired"));
            return;
          }
          create.mutate();
        }}
      >
        <p className="field__hint">{t("dashboards.team.newSpaceText")}</p>
        <FormAlert>{create.isError ? errorMessage(t, create.error) : null}</FormAlert>
        <div className="field">
          <label className="field__label" htmlFor={selectId}>
            {t("dashboards.team.team")}
          </label>
          <select
            id={selectId}
            className="select"
            value={teamId}
            onChange={(event) => {
              const next = event.currentTarget.value;
              // A name still equal to the old team's follows the new team.
              if (name === (teams.find((team) => team.id === teamId)?.name ?? "")) {
                setName(teams.find((team) => team.id === next)?.name ?? name);
              }
              setTeamId(next);
            }}
          >
            {teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </select>
        </div>
        <TextField
          label={t("dashboards.folders.name")}
          value={name}
          onValueChange={(value) => {
            setName(value);
            setError(undefined);
          }}
          error={error}
          data-autofocus
          autoComplete="off"
        />
      </form>
    </Dialog>
  );
}

/**
 * The team that owns a folder or dashboard, and who else sees it: everyone with access to the
 * place (read only), or only the team. The teams offered are the caller's own (every team for org
 * admins); the server checks the same and that the caller may manage the item's access.
 */
export function OwnerDialog({
  orgId,
  kind,
  id,
  name,
  owner,
  visibility,
  onClose,
}: {
  orgId: string;
  kind: "folders" | "dashboards";
  id: string;
  name: string;
  owner: OwnerTeam | null;
  visibility: Visibility;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { context } = useTeamContext();
  const queryClient = useQueryClient();
  const [teamId, setTeamId] = useState<string>(owner?.id ?? "");
  const [shown, setShown] = useState<Visibility>(visibility);
  const formId = useId();
  const selectId = useId();
  // The current owner stays selectable, also when the caller is not in that team.
  const teams = [
    ...context.teams.map((team) => ({ id: team.id, name: team.name })),
    ...(owner !== null && !context.teams.some((team) => team.id === owner.id) ? [owner] : []),
  ];
  const save = useMutation({
    mutationFn: () =>
      setOwner(orgId, kind, id, { ownerTeamId: teamId === "" ? null : teamId, visibility: shown }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [FOLDERS_KEY, orgId] });
      await queryClient.invalidateQueries({ queryKey: [DASHBOARDS_KEY, orgId] });
      onClose();
    },
  });
  return (
    <Dialog
      title={t("dashboards.team.ownerTitle", { name })}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="button button--secondary" onClick={onClose}>
            {t("dashboards.dialog.cancel")}
          </button>
          <button
            type="submit"
            form={formId}
            className="button button--primary"
            disabled={save.isPending}
          >
            {t("dashboards.team.ownerSave")}
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <FormAlert>{save.isError ? errorMessage(t, save.error) : null}</FormAlert>
        <div className="field">
          <label className="field__label" htmlFor={selectId}>
            {t("dashboards.team.owner")}
          </label>
          <select
            id={selectId}
            className="select"
            value={teamId}
            onChange={(event) => setTeamId(event.currentTarget.value)}
            data-autofocus
          >
            <option value="">{t("dashboards.team.noOwner")}</option>
            {teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name}
              </option>
            ))}
          </select>
        </div>
        <fieldset className="tool-choices">
          <legend className="field__label">{t("dashboards.team.visibility")}</legend>
          {(["shared", "team"] as const).map((option) => (
            <label key={option} className="radio">
              <input
                type="radio"
                name={`${formId}-visibility`}
                value={option}
                checked={shown === option}
                onChange={() => setShown(option)}
              />
              <span>{t(`dashboards.team.visibility.${option}`)}</span>
            </label>
          ))}
        </fieldset>
      </form>
    </Dialog>
  );
}
