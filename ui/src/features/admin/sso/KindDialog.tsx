import { type KeyboardEvent, useId, useRef, useState } from "react";
import { type MessageKey, useI18n } from "../../../i18n/i18n";
import { Dialog } from "../components/Dialog";
import "./sso.css";

export type ProviderKind = "oidc" | "saml" | "ldap";

const KINDS: { kind: ProviderKind; mark: string; label: MessageKey; hint: MessageKey }[] = [
  { kind: "oidc", mark: "OI", label: "sso.kind.oidc", hint: "sso.kindChoice.oidcHint" },
  { kind: "saml", mark: "SA", label: "sso.kind.saml", hint: "sso.kindChoice.samlHint" },
  { kind: "ldap", mark: "LD", label: "sso.kindChoice.ldap", hint: "sso.kindChoice.ldapHint" },
];

/**
 * "Add provider" (board frame 5B): first the kind, then the form with its dependent fields.
 * The tiles are one radio group; "Continue" opens the form of the chosen kind.
 */
export function KindDialog({
  onClose,
  onChoose,
}: {
  onClose: () => void;
  onChoose: (kind: ProviderKind) => void;
}) {
  const { t } = useI18n();
  const labelId = useId();
  const [kind, setKind] = useState<ProviderKind>("oidc");
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function onKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const step =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? 1
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? -1
          : 0;
    if (step === 0) {
      return;
    }
    event.preventDefault();
    const next = (index + step + KINDS.length) % KINDS.length;
    const choice = KINDS[next];
    if (choice !== undefined) {
      setKind(choice.kind);
      refs.current[next]?.focus();
    }
  }

  return (
    <Dialog
      open
      title={t("sso.kindChoice.title")}
      onClose={onClose}
      footer={
        <div className="sso-dialog__footer">
          <span className="sso-dialog__spacer" />
          <button type="button" className="button button--secondary" onClick={onClose}>
            {t("admin.common.cancel")}
          </button>
          <button type="button" className="button button--primary" onClick={() => onChoose(kind)}>
            {t("sso.kindChoice.continue")}
          </button>
        </div>
      }
    >
      <p className="field__label" id={labelId}>
        {t("sso.kindChoice.label")}
      </p>
      <div className="sso-kinds" role="radiogroup" aria-labelledby={labelId}>
        {KINDS.map((choice, index) => (
          // biome-ignore lint/a11y/useSemanticElements: tiles as radio buttons, as the second factor's choice
          <button
            key={choice.kind}
            ref={(element) => {
              refs.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={kind === choice.kind}
            tabIndex={kind === choice.kind ? 0 : -1}
            className="sso-kind"
            onClick={() => setKind(choice.kind)}
            onDoubleClick={() => onChoose(choice.kind)}
            onKeyDown={(event) => onKey(event, index)}
          >
            <span className="sso-mark" aria-hidden="true">
              {choice.mark}
            </span>
            <span className="sso-kind__text">
              <span>{t(choice.label)}</span>
              <span className="sso-kind__hint">{t(choice.hint)}</span>
            </span>
          </button>
        ))}
      </div>
    </Dialog>
  );
}
