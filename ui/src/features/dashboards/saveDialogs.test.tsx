import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { type DashboardModel, emptyModel, type PanelModel } from "./model";
import { QueryOptions } from "./QueryOptions";
import { SaveDialog } from "./SaveDialogs";

const panel = (id: string, extra: Partial<PanelModel> = {}): PanelModel => ({
  id,
  type: "timeseries",
  title: id,
  grid: { x: 0, y: 0, w: 12, h: 8 },
  targets: [],
  transformations: [],
  options: { legend: { placement: "bottom" } },
  fieldConfig: {},
  ...extra,
});

const base: DashboardModel = { ...emptyModel("Shop Betrieb"), panels: [panel("CPU je Host")] };
const draft: DashboardModel = {
  ...base,
  panels: [
    panel("CPU je Host", { options: { legend: { placement: "right" } } }),
    panel("Logs Checkout"),
  ],
};

describe("the save dialog", () => {
  it("lists the changes in words, with the version it makes", () => {
    render(
      <SaveDialog
        busy={false}
        error={undefined}
        base={base}
        draft={draft}
        version={41}
        onSave={() => {}}
        onClose={() => {}}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Save dashboard" });
    expect(within(dialog).getByText("Shop Betrieb · version 41 becomes 42")).toBeTruthy();
    const tab = within(dialog).getByRole("tab", { name: /Changes/ });
    expect(tab.getAttribute("aria-selected")).toBe("true");
    expect(tab.textContent).toContain("2");
    const rows = within(dialog)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(rows).toEqual(["Panel “CPU je Host”: optionschanged", "Panel “Logs Checkout” addednew"]);
  });

  it("shows the same changes as JSON with + and - and a spoken name for each", async () => {
    const user = userEvent.setup();
    render(
      <SaveDialog
        busy={false}
        error={undefined}
        base={base}
        draft={draft}
        version={1}
        onSave={() => {}}
        onClose={() => {}}
      />,
    );
    await user.click(screen.getByRole("tab", { name: "As JSON" }));
    const json = screen.getByRole("tabpanel", { name: "As JSON" });
    expect(within(json).getByRole("region", { name: "panels[0]" })).toBeTruthy();
    expect(within(json).getByRole("region", { name: "panels[1]" })).toBeTruthy();
    expect(json.textContent).toContain('- removed:       "placement": "bottom"');
    expect(json.textContent).toContain('+ added:       "placement": "right"');
  });

  it("saves with the message and offers a copy", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const onSaveCopy = vi.fn();
    render(
      <SaveDialog
        busy={false}
        error={undefined}
        base={base}
        draft={draft}
        version={1}
        onSave={onSave}
        onSaveCopy={onSaveCopy}
        onClose={() => {}}
      />,
    );
    await user.type(screen.getByLabelText("What changed (optional)"), "Legende rechts");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith("Legende rechts", { range: false, values: false });
    await user.click(screen.getByRole("button", { name: "Save as copy…" }));
    expect(onSaveCopy).toHaveBeenCalled();
  });
});

function Options({ initial }: { initial: PanelModel }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <QueryOptions
        panel={value}
        range={{ from: 0, to: 6 * 3_600_000 }}
        onChange={(c) => setValue(c)}
      />
      <output data-testid="panel">{JSON.stringify(value)}</output>
    </>
  );
}

describe("the query options", () => {
  it("say what is set while closed and what Auto picks", () => {
    render(<Options initial={panel("p", { minInterval: "1m", timeShift: "1d" })} />);
    const toggle = screen.getByRole("button", { name: /Query options/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.textContent).toContain("Points: Auto (1,000) · Interval: 1m · 1d earlier");
  });

  it("keep valid values only and show the interval they give", async () => {
    const user = userEvent.setup();
    render(<Options initial={panel("p")} />);
    await user.click(screen.getByRole("button", { name: /Query options/ }));
    const points = screen.getByLabelText("Maximum data points");
    await user.type(points, "0");
    expect(points.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByTestId("panel").textContent).not.toContain("maxDataPoints");
    await user.clear(points);
    await user.type(points, "100");
    expect(screen.getByTestId("panel").textContent).toContain('"maxDataPoints":100');
    expect(screen.getByText("$__interval = 216s")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Smallest interval"), { target: { value: "5m" } });
    expect(screen.getByText("$__interval = 5m")).toBeTruthy();
    expect(screen.getByText(/raised to the smallest interval/)).toBeTruthy();
    await user.click(screen.getByLabelText("Hide time note in the panel header"));
    expect(screen.getByTestId("panel").textContent).toContain('"hideTimeNote":true');
  });
});
