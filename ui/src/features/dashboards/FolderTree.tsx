import type { KeyboardEvent } from "react";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n/i18n";
import type { Folder } from "./api";
import "./dashboards.css";

export interface FolderNode {
  folder: Folder;
  children: FolderNode[];
}

/**
 * Builds the tree from the flat list the server sends. It contains only folders the caller may
 * see; a folder whose parent is hidden from them is shown at the top level instead of vanishing.
 */
export function buildTree(folders: readonly Folder[]): FolderNode[] {
  const nodes = new Map(
    folders.map((folder) => [folder.id, { folder, children: [] as FolderNode[] }]),
  );
  const roots: FolderNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.folder.parentId === null ? undefined : nodes.get(node.folder.parentId);
    (parent?.children ?? roots).push(node);
  }
  const sort = (list: FolderNode[]) => {
    list.sort((a, b) => a.folder.name.localeCompare(b.folder.name));
    for (const node of list) {
      sort(node.children);
    }
  };
  sort(roots);
  return roots;
}

/** Whether the folder or a folder above it is restricted; subfolders inherit the restriction. */
export function isRestricted(folders: readonly Folder[], id: string | undefined): boolean {
  const byId = new Map(folders.map((f) => [f.id, f]));
  for (let f = id === undefined ? undefined : byId.get(id); f !== undefined; ) {
    if (f.restricted) {
      return true;
    }
    f = f.parentId === null ? undefined : byId.get(f.parentId);
  }
  return false;
}

/** Ids of a folder and all folders below it, so a folder cannot be moved into itself. */
export function descendantIds(folders: readonly Folder[], id: string): Set<string> {
  const ids = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const folder of folders) {
      if (folder.parentId !== null && ids.has(folder.parentId) && !ids.has(folder.id)) {
        ids.add(folder.id);
        grew = true;
      }
    }
  }
  return ids;
}

interface FolderTreeProps {
  folders: readonly Folder[];
  selected: string | undefined;
  onSelect: (id: string | undefined) => void;
}

/** Folder navigation; Up and Down move between entries, Home and End jump. */
export function FolderTree({ folders, selected, onSelect }: FolderTreeProps) {
  const { t } = useI18n();

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(".folder-tree__item"),
    );
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: HTMLButtonElement | undefined;
    if (event.key === "ArrowDown") next = items[Math.min(index + 1, items.length - 1)];
    if (event.key === "ArrowUp") next = items[Math.max(index - 1, 0)];
    if (event.key === "Home") next = items[0];
    if (event.key === "End") next = items.at(-1);
    if (next !== undefined) {
      event.preventDefault();
      next.focus();
    }
  }

  // Subfolders inherit a restriction; they show the lock too, with their own explanation.
  const renderNodes = (nodes: FolderNode[], inherited = false) => (
    <ul className="folder-tree__list">
      {nodes.map(({ folder, children }) => (
        <li key={folder.id}>
          <button
            type="button"
            className="folder-tree__item"
            aria-current={selected === folder.id ? "true" : undefined}
            onClick={() => onSelect(folder.id)}
            title={
              folder.restricted
                ? t("dashboards.folders.restrictedHint")
                : inherited
                  ? t("dashboards.folders.restrictedInheritedHint")
                  : undefined
            }
          >
            <span className="folder-tree__name">
              <Icon name="folder" />
              <span className="truncate">{folder.name}</span>
            </span>
            {folder.restricted || inherited ? (
              <span className="folder-tree__restricted">
                <Icon name="lock" />
                <span className="visually-hidden">{`, ${t("dashboards.folders.restricted")}`}</span>
              </span>
            ) : null}
          </button>
          {children.length === 0 ? null : renderNodes(children, inherited || folder.restricted)}
        </li>
      ))}
    </ul>
  );

  return (
    <nav className="folder-tree" aria-label={t("dashboards.folders.label")} onKeyDown={onKeyDown}>
      <ul className="folder-tree__list">
        <li>
          <button
            type="button"
            className="folder-tree__item"
            aria-current={selected === undefined ? "true" : undefined}
            onClick={() => onSelect(undefined)}
          >
            <span className="folder-tree__name">
              <Icon name="dashboards" />
              <span className="truncate">{t("dashboards.folders.all")}</span>
            </span>
          </button>
        </li>
      </ul>
      {renderNodes(buildTree(folders))}
    </nav>
  );
}
