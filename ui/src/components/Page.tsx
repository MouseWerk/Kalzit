import type { ReactNode } from "react";

/** Page body inside the app shell: one h1 with an optional lead line, then the content. */
export function Page({
  title,
  lead,
  children,
}: {
  title: string;
  lead?: string;
  children: ReactNode;
}) {
  return (
    <div className="page">
      <div className="page__header">
        <h1>{title}</h1>
        {lead === undefined ? null : <p className="page__lead">{lead}</p>}
      </div>
      {children}
    </div>
  );
}
