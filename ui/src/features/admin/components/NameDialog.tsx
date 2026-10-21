import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useRef, useState } from "react";
import { isApiError } from "../../../api/client";
import { trimWhitespace } from "../../../auth/validation";
import { TextField } from "../../../components/TextField";
import { useI18n } from "../../../i18n/i18n";
import { type ErrorTexts, errorText } from "../errors";
import { nameMessage } from "../validation";
import { Dialog } from "./Dialog";

/**
 * Asks for one name (a new team, renaming an organization). The name is checked as the server
 * checks names: required, at most 100 characters, no control characters.
 */
export function NameDialog({
  open,
  title,
  label,
  initial = "",
  submitLabel,
  onClose,
  onSubmit,
  errors = {},
}: {
  open: boolean;
  title: string;
  label: string;
  initial?: string;
  submitLabel: string;
  onClose: () => void;
  onSubmit: (name: string) => Promise<unknown>;
  errors?: ErrorTexts;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(initial);
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  const save = useMutation({
    mutationFn: onSubmit,
    onError: (error) => {
      // The server's answer about the name (rejected, taken) belongs to the field.
      if (isApiError(error) && error.field === "name") {
        setFieldError(
          errorText(t, error, { "validation:name": "validation.serverRejected", ...errors }),
        );
        inputRef.current?.focus();
      }
    },
  });
  const nameProblem = isApiError(save.error) && save.error.field === "name";

  function close() {
    save.reset();
    setFieldError(undefined);
    setName(initial);
    onClose();
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (save.isPending) {
      return;
    }
    const problem = nameMessage(name);
    setFieldError(problem === undefined ? undefined : t(problem.key, problem.params));
    if (problem !== undefined) {
      inputRef.current?.focus();
      return;
    }
    save.mutate(trimWhitespace(name), {
      onSuccess: () => {
        save.reset();
        setName(initial);
        onClose();
      },
    });
  }

  return (
    <Dialog open={open} title={title} onClose={close} initialFocus={inputRef}>
      <form className="form" noValidate onSubmit={submit}>
        <TextField
          ref={inputRef}
          label={label}
          value={name}
          autoComplete="off"
          onValueChange={(value) => {
            setName(value);
            setFieldError(undefined);
          }}
          error={fieldError}
        />
        {save.error === null || nameProblem ? null : (
          <p className="admin-error" role="alert">
            {errorText(t, save.error, errors)}
          </p>
        )}
        <div className="admin-dialog__footer">
          <button type="button" className="button button--secondary" onClick={close}>
            {t("admin.common.cancel")}
          </button>
          <button type="submit" className="button button--primary" aria-disabled={save.isPending}>
            {submitLabel}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
