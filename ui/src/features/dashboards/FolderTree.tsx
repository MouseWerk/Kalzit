import { type KeyboardEvent, useState } from "react";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n/i18n";
import { readPreference, writePreference } from "../../lib/storage";
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

/** Ids of the folders above `id`, nearest first. */
function ancestorIds(folders: readonly Folder[], id: string | undefined): string[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const ids: string[] = [];
  let parent = id === undefined ? undefined : byId.get(id)?.parentId;
  while (parent !== null && parent !== undefined && !ids.includes(parent)) {
    ids.push(parent);
    parent = byId.get(parent)?.parentId;
  }
  return ids;
}

/** The folders folded in this browser, per account; folders are open until folded. */
function readFolded(key: string | undefined): string[] {
  if (key === undefined) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(readPreference(key) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

interface FolderTreeProps {
  folders: readonly Folder[];
  selected: string | undefined;
  onSelect: (id: string | undefined) => void;
  /** Where the folded folders are kept in this browser (per account); in memory when left out. */
  storageKey?: string | undefined;
}

/**
 * Folder navigation after the tree view pattern: Up and Down move between the shown entries,
 * Home and End jump, Right opens a folder (or moves into it), Left folds it (or moves to its
 * parent). A folder with subfolders has a chevron that folds it; the path to the current folder
 * is always open. "Fold all" folds every folder.
 */
export function FolderTree({ folders, selected, onSelect, storageKey }: FolderTreeProps) {
  const { t } = useI18n();
  const [folded, setFolded] = useState<string[]>(() => readFolded(storageKey));
  const tree = buildTree(folders);
  const withChildren = folders.filter((f) => folders.some((c) => c.parentId === f.id));
  // The way to the current folder stays open, whatever was folded before.
  const path = ancestorIds(folders, selected);
  const isOpen = (id: string) => !folded.includes(id) || path.includes(id);

  function store(next: string[]) {
    setFolded(next);
    if (storageKey !== undefined) {
      writePreference(storageKey, JSON.stringify(next));
    }
  }
  const setOpen = (id: string, open: boolean) =>
    store(open ? folded.filter((f) => f !== id) : [...folded.filter((f) => f !== id), id]);

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(".folder-tree__item"),
    );
    const current = document.activeElement as HTMLButtonElement;
    const index = items.indexOf(current);
    if (index === -1) {
      return;
    }
    const id = current.dataset.folderId;
    let next: HTMLButtonElement | undefined;
    if (event.key === "ArrowDown") next = items[Math.min(index + 1, items.length - 1)];
    if (event.key === "ArrowUp") next = items[Math.max(index - 1, 0)];
    if (event.key === "Home") next = items[0];
    if (event.key === "End") next = items.at(-1);
    if (event.key === "ArrowRight" && id !== undefined) {
      if (current.getAttribute("aria-expanded") === "false") {
        event.preventDefault();
        setOpen(id, true);
        return;
      }
      if (current.getAttribute("aria-expanded") === "true") next = items[index + 1];
    }
    if (event.key === "ArrowLeft" && id !== undefined) {
      if (current.getAttribute("aria-expanded") === "true" && !path.includes(id)) {
        event.preventDefault();
        setOpen(id, false);
        return;
      }
      const parent = folders.find((f) => f.id === id)?.parentId;
      next =
        parent === null || parent === undefined
          ? items[0]
          : items.find((item) => item.dataset.folderId === parent);
    }
    if (next !== undefined) {
      event.preventDefault();
      next.focus();
    }
  }

  // Subfolders inherit a restriction; they show the lock too, with their own explanation.
  const renderNodes = (nodes: FolderNode[], inherited = false) => (
    <ul className="folder-tree__list">
      {nodes.map(({ folder, children }) => {
        const hasChildren = children.length > 0;
        const open = hasChildren && isOpen(folder.id);
        return (
          <li key={folder.id} className="folder-tree__node">
            {hasChildren ? (
              <button
                type="button"
                className="folder-tree__toggle"
                tabIndex={-1}
                aria-hidden="true"
                disabled={open && path.includes(folder.id)}
                onClick={() => setOpen(folder.id, !open)}
              >
                <Icon name={open ? "chevronDown" : "chevron"} />
              </button>
            ) : null}
            <button
              type="button"
              className="folder-tree__item"
              data-folder-id={folder.id}
              aria-current={selected === folder.id ? "true" : undefined}
              aria-expanded={hasChildren ? open : undefined}
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
            {open ? renderNodes(children, inherited || folder.restricted) : null}
          </li>
        );
      })}
    </ul>
  );

  return (
    <nav className="folder-tree" aria-label={t("dashboards.folders.label")} onKeyDown={onKeyDown}>
      <div className="folder-tree__head">
        <span className="folder-tree__heading" aria-hidden="true">
          {t("dashboards.folders.label")}
        </span>
        {withChildren.length === 0 ? null : (
          <button
            type="button"
            className="folder-tree__fold-all"
            disabled={withChildren.every((f) => !isOpen(f.id) || path.includes(f.id))}
            onClick={() => store(withChildren.map((f) => f.id))}
          >
            {t("dashboards.folders.foldAll")}
          </button>
        )}
      </div>
      <ul className="folder-tree__list">
        <li className="folder-tree__node">
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
      {renderNodes(tree)}
    </nav>
  );
}
