import { type FakeArea, json } from "../../../test/fakeServer";
import type { AcmeChecked, AcmeSettings, AcmeView } from "../acmeApi";

/**
 * The ACME routes of docs/api/settings-dashboards.md, "HTTPS certificates", for tests: the view
 * as stored, a save that keeps the settings and counts the version (or the refusal arranged for
 * it), the test's answer, and a renewal that starts an order. The server does the checking; here
 * the answers are given.
 */

type Refusal = {
  status: number;
  code: string;
  field?: string;
  reason?: string;
  params?: Record<string, string>;
};

export interface FakeAcmeState {
  view: AcmeView;
  /** The answer of the next save: a refusal, or nothing (saved). */
  saveAnswer?: Refusal | undefined;
  /** The answer of the next test. */
  testAnswer: AcmeChecked | Refusal;
}

export const ACME_AT = Date.UTC(2026, 9, 28, 9, 12);

export function acmeSettings(fields: Partial<AcmeSettings> = {}): AcmeSettings {
  return {
    enabled: false,
    directory: "letsencrypt",
    directoryUrl: "",
    directoryCa: "",
    domains: [],
    email: "",
    challenge: "http-01",
    acceptTerms: false,
    ...fields,
  };
}

export function acmeFake(): FakeArea<FakeAcmeState> {
  const state: FakeAcmeState = {
    view: {
      settings: acmeSettings(),
      version: 0,
      status: {
        phase: "off",
        certificate: null,
        nextAttemptAt: null,
        lastError: null,
        failures: 0,
      },
      server: { httpAddr: "0.0.0.0:80", httpsAddr: "0.0.0.0:443", certificateFiles: false },
    },
    testAnswer: { termsOfService: "https://ca.example/terms.pdf", warnings: [] },
  };
  return { state, handle: () => undefined };
}

function refusal(answer: Refusal) {
  const error: Record<string, unknown> = {
    code: answer.code,
    message: `server message for ${answer.code}`,
  };
  if (answer.field !== undefined) error.field = answer.field;
  if (answer.reason !== undefined) error.reason = answer.reason;
  if (answer.params !== undefined) error.params = answer.params;
  return json(answer.status, { error });
}

export function handleAcmeRoute(
  state: FakeAcmeState,
  path: string,
  method: string,
  body: Record<string, unknown>,
): Response | undefined {
  const route = path.split("?")[0] ?? "";
  if (route === "/api/admin/acme" && method === "GET") {
    return json(200, state.view);
  }
  if (route === "/api/admin/acme" && method === "PUT") {
    const answer = state.saveAnswer;
    state.saveAnswer = undefined;
    if (answer !== undefined) {
      return refusal(answer);
    }
    if (body.version !== state.view.version) {
      return json(409, {
        error: { code: "version_conflict", message: "changed meanwhile" },
        current: state.view,
      });
    }
    const settings = body.settings as AcmeSettings;
    state.view = {
      ...state.view,
      settings,
      version: state.view.version + 1,
      status: { ...state.view.status, phase: settings.enabled ? "waiting" : "off" },
    };
    return json(200, state.view);
  }
  if (route === "/api/admin/acme/test" && method === "POST") {
    const answer = state.testAnswer;
    return "status" in answer ? refusal(answer) : json(200, answer);
  }
  if (route === "/api/admin/acme/renew" && method === "POST") {
    if (!state.view.settings.enabled) {
      return refusal({ status: 409, code: "conflict", field: "enabled", reason: "acme.off" });
    }
    state.view = { ...state.view, status: { ...state.view.status, phase: "working" } };
    return json(200, state.view);
  }
  return undefined;
}
