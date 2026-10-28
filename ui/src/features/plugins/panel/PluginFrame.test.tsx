import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Frame } from "../../../api/generated/shapes";
import { setLanguage } from "../../../i18n/i18n";
import { type PanelHost, PanelHostContext } from "../../../panels/host";
import { PanelPicker } from "../../../panels/picker/PanelPicker";
import { getPanel, setExternalPanels } from "../../../panels/registry";
import type { PanelSeries } from "../../../panels/types";
import { expectConsoleOutput } from "../../../test/console";
import type { PanelPluginInfo } from "./api";
import { PluginFrame, READY_TIMEOUT_MS, sameSeries } from "./PluginFrame";
import { PluginOptionsEditor, pluginPanelType } from "./types";

const INFO: PanelPluginInfo = {
  id: "dev.example.tile",
  name: "KPI tile",
  version: "1.2.0",
  description: "The latest value of a field",
  publisher: "Example GmbH",
  signer: "publisher",
  shapes: ["frame"],
  api: 1,
  options: [
    { name: "field", label: { en: "Field", de: "Feld" }, type: "string" },
    {
      name: "decimals",
      label: { en: "Decimals", de: "Nachkommastellen" },
      type: "integer",
      min: 0,
      max: 10,
      default: 2,
    },
    { name: "spark", label: { en: "Sparkline" }, type: "bool" },
    {
      name: "mode",
      label: { en: "Mode" },
      type: "select",
      choices: ["last", "mean"],
      default: "last",
    },
  ],
};

const FRAME: Frame = {
  fields: [{ name: "cpu", type: "number", values: [1, 2, 3] }],
  meta: { rowsTruncated: false, notices: [] },
} as unknown as Frame;

const SERIES: PanelSeries[] = [{ refId: "A", result: { shape: "frame", frame: FRAME } }];

function draw(host: PanelHost = { orgId: "org-1", dashboardId: "dash-1" }, series = SERIES) {
  const view = render(
    <PanelHostContext value={host}>
      <PluginFrame
        info={INFO}
        options={{ field: "cpu", decimals: 2 }}
        series={series}
        timeRange={{ from: 1, to: 2 }}
        title="CPU"
      />
    </PanelHostContext>,
  );
  const iframe = view.container.querySelector("iframe") as HTMLIFrameElement;
  const target = iframe.contentWindow as Window;
  const sent: { type: string; [key: string]: unknown }[] = [];
  vi.spyOn(target, "postMessage").mockImplementation((data: unknown) => {
    sent.push(data as { type: string });
  });
  // The frame's own document has loaded.
  fireEvent.load(iframe);
  return { ...view, iframe, target, sent };
}

/** A message as the sandboxed frame's window sends it: source the frame, origin opaque. */
function fromFrame(target: Window | null, data: unknown, origin = "null") {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data, origin, source: target }));
  });
}

const event = (fields: Record<string, unknown>) => ({ kalzit: "panel", api: 1, ...fields });

afterEach(() => {
  vi.useRealTimers();
  setExternalPanels([]);
});

describe("the panel frame", () => {
  it("loads the bundle sandboxed from the dashboard's frame address", () => {
    const { iframe } = draw();
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(iframe.getAttribute("src")).toBe(
      "/api/orgs/org-1/panel-plugins/dev.example.tile/frame?dashboard=dash-1&v=1.2.0",
    );
    expect(iframe.title).toBe("CPU (plugin panel)");
  });

  it("answers ready with init and the data, and then sends what changes", () => {
    const { target, sent, rerender } = draw();
    fromFrame(target, event({ type: "ready" }));
    expect(sent.map((m) => m.type)).toEqual(["init", "data"]);
    const [init, data] = sent;
    expect(init).toMatchObject({
      kalzit: "panel",
      api: 1,
      options: { field: "cpu", decimals: 2 },
      locale: "en",
      title: "CPU",
      mode: "view",
      theme: { scheme: expect.stringMatching(/^(light|dark)$/) },
    });
    expect(data).toMatchObject({ series: SERIES, timeRange: { from: 1, to: 2 }, revision: 1 });

    // Results built anew but the same: nothing is sent. New options: only the options.
    rerender(
      <PanelHostContext value={{ orgId: "org-1", dashboardId: "dash-1" }}>
        <PluginFrame
          info={INFO}
          options={{ field: "mem", decimals: 2 }}
          series={[{ ...SERIES[0] } as PanelSeries]}
          timeRange={{ from: 1, to: 2 }}
          title="CPU"
        />
      </PanelHostContext>,
    );
    expect(sent.map((m) => m.type)).toEqual(["init", "data", "options"]);
    expect(sent[2]).toMatchObject({ options: { field: "mem", decimals: 2 } });
  });

  it("listens only to its own frame, with the opaque origin", () => {
    expectConsoleOutput(
      /\[panel dev\.example\.tile\] dropped a message from origin https:\/\/evil\.example/,
    );
    const { target, sent } = draw();
    // Another window (the page itself, another panel) is not this frame.
    fromFrame(window, event({ type: "ready" }));
    // The frame's window, but not from the sandbox: refused.
    fromFrame(target, event({ type: "ready" }), "https://evil.example");
    expect(sent).toEqual([]);
    fromFrame(target, event({ type: "ready" }));
    expect(sent.map((m) => m.type)).toEqual(["init", "data"]);
  });

  it("drops events that do not fit the API, saying why in the console", () => {
    expectConsoleOutput(
      /dropped an event \(panel\.type_unknown\)/,
      /dropped an event \(panel\.api_unsupported\)/,
      /dropped an event \(panel\.field_invalid\)/,
    );
    const { target, sent, container } = draw();
    fromFrame(target, event({ type: "ready" }));
    fromFrame(target, event({ type: "runQuery", sql: "DROP TABLE x" }));
    fromFrame(target, { kalzit: "panel", api: 2, type: "resize", height: 100 });
    fromFrame(target, event({ type: "resize", height: 99_999 }));
    expect(sent.map((m) => m.type)).toEqual(["init", "data"]);
    const wrapper = container.querySelector(".plugin-frame") as HTMLElement;
    expect(wrapper.style.getPropertyValue("--plugin-frame-height")).not.toBe("99999px");
  });

  it("gives the frame the height it asks for", () => {
    const { target, container } = draw();
    fromFrame(target, event({ type: "ready" }));
    fromFrame(target, event({ type: "resize", height: 480 }));
    const wrapper = container.querySelector(".plugin-frame") as HTMLElement;
    expect(wrapper.style.getPropertyValue("--plugin-frame-height")).toBe("480px");
  });

  it("takes options only in the editor, and only those the manifest allows", () => {
    expectConsoleOutput(
      /dropped setOptions: the panel is not being edited/,
      /dropped setOptions \(panel\.option_invalid\): options\.decimals/,
      /dropped setOptions \(panel\.option_unknown\)/,
    );
    const viewing = draw();
    fromFrame(viewing.target, event({ type: "ready" }));
    fromFrame(viewing.target, event({ type: "setOptions", options: { field: "x" } }));
    viewing.unmount();

    const editOptions = vi.fn();
    const editing = draw({ orgId: "org-1", dashboardId: "dash-1", editOptions });
    fromFrame(editing.target, event({ type: "ready" }));
    expect(editing.sent[0]).toMatchObject({ type: "init", mode: "edit" });
    fromFrame(editing.target, event({ type: "setOptions", options: { decimals: 11 } }));
    fromFrame(editing.target, event({ type: "setOptions", options: { token: "x" } }));
    expect(editOptions).not.toHaveBeenCalled();
    fromFrame(
      editing.target,
      event({ type: "setOptions", options: { field: "mem", decimals: 4 } }),
    );
    expect(editOptions).toHaveBeenCalledWith({ field: "mem", decimals: 4 });
  });

  it("opens a link only after the viewer confirms, without a referrer", async () => {
    expectConsoleOutput(
      /dropped an event \(panel\.field_invalid\): url is an http or https address/,
    );
    const user = userEvent.setup();
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const { target } = draw();
    fromFrame(target, event({ type: "ready" }));
    fromFrame(target, event({ type: "link", url: "javascript:alert(1)" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fromFrame(
      target,
      event({ type: "link", url: "https://example.com/runbook", title: "Runbook" }),
    );
    let dialog = screen.getByRole("dialog", { name: "Open link?" });
    expect(within(dialog).getByText("https://example.com/runbook")).toBeTruthy();
    expect(within(dialog).getByText("Runbook")).toBeTruthy();
    // Cancel has the focus, so Enter does not open it.
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" }));
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(open).not.toHaveBeenCalled();
    fromFrame(target, event({ type: "link", url: "https://example.com/runbook" }));
    dialog = screen.getByRole("dialog", { name: "Open link?" });
    await user.click(within(dialog).getByRole("button", { name: "Open" }));
    expect(open).toHaveBeenCalledWith(
      "https://example.com/runbook",
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("keeps log lines to five per second and events to twenty", () => {
    // One second for all of them.
    vi.useFakeTimers({ toFake: ["Date"], now: 1_800_000_000_000 });
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    expectConsoleOutput(/\[panel dev\.example\.tile\] line 0/);
    const { target } = draw();
    fromFrame(target, event({ type: "ready" }));
    for (let i = 0; i < 30; i += 1) {
      fromFrame(
        target,
        event({ type: "log", level: i === 0 ? "warn" : "info", text: `line ${i}` }),
      );
    }
    // One warning and four info lines: the sixth line on is dropped.
    expect(info.mock.calls.length).toBe(4);
  });

  it("shows an error when the panel does not start, and starts it again", () => {
    vi.useFakeTimers();
    expectConsoleOutput(/did not say ready within 10 s/);
    const { getByRole, container } = draw();
    act(() => {
      vi.advanceTimersByTime(READY_TIMEOUT_MS + 1);
    });
    const alert = getByRole("alert");
    expect(alert.textContent).toContain("The panel did not start within 10 seconds.");
    expect(container.querySelector("iframe")).toBeNull();
    fireEvent.click(getByRole("button", { name: "Try again" }));
    expect(container.querySelector("iframe")).not.toBeNull();
  });

  it("stops a panel that navigates its frame away", () => {
    expectConsoleOutput(/navigated away from its bundle and was stopped/);
    const { iframe, getByRole, container } = draw();
    fireEvent.load(iframe);
    expect(getByRole("alert").textContent).toContain(
      "The panel tried to leave its frame and was stopped.",
    );
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("tells results apart by their objects", () => {
    expect(sameSeries(SERIES, [{ ...SERIES[0] } as PanelSeries])).toBe(true);
    expect(
      sameSeries(SERIES, [{ refId: "A", result: { shape: "frame", frame: { ...FRAME } } }]),
    ).toBe(false);
    expect(sameSeries(SERIES, [])).toBe(false);
  });
});

describe("a panel plugin's type", () => {
  it("is offered in the picker after the built-in ones, marked with its publisher", () => {
    setExternalPanels([pluginPanelType(INFO)]);
    render(<PanelPicker value="timeseries" shapes={["frame"]} onChange={() => undefined} />);
    const card = screen.getByRole("radio", { name: "KPI tile" }).closest("label") as HTMLElement;
    expect(within(card).getByText("Plugin · Example GmbH")).toBeTruthy();
    expect(within(card).getByText("The latest value of a field")).toBeTruthy();
    const names = screen.getAllByRole("radio").map((r) => r.getAttribute("value"));
    expect(names.indexOf("dev.example.tile")).toBeGreaterThan(names.indexOf("timeseries"));
    expect(getPanel("dev.example.tile")?.external).toBe(true);
  });

  it("builds its options editor from the manifest, in the user's language", async () => {
    setLanguage("de");
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <PluginOptionsEditor
        info={INFO}
        options={{ decimals: 2, mode: "last" }}
        onChange={onChange}
      />,
    );
    expect(screen.getByLabelText("Feld")).toBeTruthy();
    expect(screen.getByLabelText("Sparkline").getAttribute("type")).toBe("checkbox");
    const decimals = screen.getByLabelText("Nachkommastellen") as HTMLInputElement;
    expect([decimals.min, decimals.max, decimals.step]).toEqual(["0", "10", "1"]);
    await user.type(screen.getByLabelText("Feld"), "c");
    expect(onChange).toHaveBeenLastCalledWith({ decimals: 2, mode: "last", field: "c" });
    await user.selectOptions(screen.getByLabelText("Mode"), "mean");
    expect(onChange).toHaveBeenLastCalledWith({ decimals: 2, mode: "mean" });
    await user.clear(decimals);
    await user.type(decimals, "11");
    // 11 is outside the range: never written.
    expect(onChange).not.toHaveBeenCalledWith(expect.objectContaining({ decimals: 11 }));
  });

  it("says when a panel has no options", () => {
    render(
      <PluginOptionsEditor
        info={{ ...INFO, options: [] }}
        options={{}}
        onChange={() => undefined}
      />,
    );
    expect(screen.getByText("This panel has no options.")).toBeTruthy();
  });
});
