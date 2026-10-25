import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Icon, type IconName } from "../../components/Icon";
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

/** The tree's own key for "All dashboards", which has no folder id. */
const ALL = "";

/**
 * Folder navigation as an ARIA tree view: one tab stop (the current entry), Up and Down move
 * between the shown entries, Home and End jump, Right opens a folder (or moves into it), Left
 * folds it (or moves to its parent), Enter and Space open the folder. A folder with subfolders
 * has a chevron that folds it for the pointer; the path to the current folder is always open,
 * and "Fold all" folds every folder.
 */
export function FolderTree({ folders, selected, onSelect, storageKey }: FolderTreeProps) {
  const { t } = useI18n();
  const ids = useId();
  const treeRef = useRef<HTMLDivElement>(null);
  const [folded, setFolded] = useState<string[]>(() => readFolded(storageKey));
  const [focused, setFocused] = useState<string>(selected ?? ALL);
  const byId = new Map(folders.map((f) => [f.id, f]));
  const withChildren = folders.filter((f) => folders.some((c) => c.parentId === f.id));
  // The way to the current folder stays open, whatever was folded before.
  const path = ancestorIds(folders, selected);
  const isOpen = (id: string) => !folded.includes(id) || path.includes(id);
  // What is shown in order: the tab stop must be one of these.
  const shown: string[] = [ALL];
  const walk = (nodes: FolderNode[]) => {
    for (const node of nodes) {
      shown.push(node.folder.id);
      if (node.children.length > 0 && isOpen(node.folder.id)) {
        walk(node.children);
      }
    }
  };
  const tree = buildTree(folders);
  walk(tree);
  const tabStop = shown.includes(focused) ? focused : (selected ?? ALL);

  function store(next: string[]) {
    setFolded(next);
    if (storageKey !== undefined) {
      writePreference(storageKey, JSON.stringify(next));
    }
  }

  // Folders that no longer exist (or no longer have subfolders) leave the stored list.
  useEffect(() => {
    if (folders.length === 0) {
      return;
    }
    const kept = folded.filter((id) => folders.some((f) => f.parentId === id));
    if (kept.length !== folded.length) {
      store(kept);
    }
  });

  function focusItem(id: string) {
    setFocused(id);
    treeRef.current?.querySelector<HTMLElement>(`[data-tree-id="${CSS.escape(id)}"]`)?.focus();
  }

  /** Folds `ids`; a focused entry inside them moves to the folder that hid it. */
  function fold(foldIds: string[]) {
    store([...folded.filter((id) => !foldIds.includes(id)), ...foldIds]);
    const hiddenBy = ancestorIds(folders, focused === ALL ? undefined : focused)
      .reverse()
      .find((id) => foldIds.includes(id) && !path.includes(id));
    if (hiddenBy !== undefined) {
      const inTree = treeRef.current?.contains(document.activeElement) === true;
      setFocused(hiddenBy);
      if (inTree) {
        // After the fold has rendered, the folder is the entry to focus.
        requestAnimationFrame(() => focusItem(hiddenBy));
      }
    }
  }
  const unfold = (id: string) => store(folded.filter((f) => f !== id));

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    const index = shown.indexOf(tabStop);
    const id = tabStop;
    const hasChildren = id !== ALL && withChildren.some((f) => f.id === id);
    let next: string | undefined;
    switch (event.key) {
      case "ArrowDown":
        next = shown[Math.min(index + 1, shown.length - 1)];
        break;
      case "ArrowUp":
        next = shown[Math.max(index - 1, 0)];
        break;
      case "Home":
        next = shown[0];
        break;
      case "End":
        next = shown.at(-1);
        break;
      case "ArrowRight":
        if (hasChildren && !isOpen(id)) {
          event.preventDefault();
          unfold(id);
          return;
        }
        if (hasChildren) next = shown[index + 1];
        break;
      case "ArrowLeft": {
        if (hasChildren && isOpen(id) && !path.includes(id)) {
          event.preventDefault();
          fold([id]);
          return;
        }
        const parent = id === ALL ? undefined : byId.get(id)?.parentId;
        next = parent === null || parent === undefined ? undefined : parent;
        break;
      }
      case "Enter":
      case " ":
        event.preventDefault();
        onSelect(id === ALL ? undefined : id);
        return;
      default:
        return;
    }
    event.preventDefault();
    if (next !== undefined) {
      focusItem(next);
    }
  }

  const item = (
    id: string,
    level: number,
    label: ReactNode,
    icon: IconName,
    extra: { hasChildren: boolean; open: boolean; title?: string | undefined },
    children: ReactNode,
  ) => {
    const current = (selected ?? ALL) === id;
    const groupId = `${ids}-${id || "all"}-group`;
    return (
      // The row is the tree item and owns the group of subfolders beside it, so the focus ring
      // goes round the row alone.
      <div key={id || "all"} className="folder-tree__node">
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: the tree takes the keys (arrows, Enter, Space) for every item */}
        <div
          role="treeitem"
          className="folder-tree__item"
          data-tree-id={id}
          data-current={current ? "true" : undefined}
          aria-level={level}
          aria-selected={current}
          aria-expanded={extra.hasChildren ? extra.open : undefined}
          aria-owns={children === null ? undefined : groupId}
          // Named by its own label: the owned subfolders would join a name from the content.
          aria-labelledby={`${ids}-${id || "all"}-name`}
          tabIndex={id === tabStop ? 0 : -1}
          title={extra.title}
          onFocus={() => setFocused(id)}
          onClick={() => {
            setFocused(id);
            onSelect(id === ALL ? undefined : id);
          }}
        >
          {extra.hasChildren ? (
            <span
              className="folder-tree__toggle"
              aria-hidden="true"
              data-disabled={extra.open && path.includes(id) ? "true" : undefined}
              onClick={(event) => {
                event.stopPropagation();
                if (extra.open && path.includes(id)) return;
                if (extra.open) fold([id]);
                else unfold(id);
              }}
            >
              <Icon name={extra.open ? "chevronDown" : "chevron"} />
            </span>
          ) : (
            <span className="folder-tree__toggle" aria-hidden="true" />
          )}
          <span className="folder-tree__name" id={`${ids}-${id || "all"}-name`}>
            <Icon name={icon} />
            {label}
          </span>
        </div>
        {children === null ? null : (
          // biome-ignore lint/a11y/useSemanticElements: a tree item's subfolders are its group, not a fieldset
          <div role="group" id={groupId} className="folder-tree__list">
            {children}
          </div>
        )}
      </div>
    );
  };
  // Subfolders inherit a restriction; they show the lock too, with their own explanation.
  const renderNodes = (nodes: FolderNode[], level: number, inherited = false): ReactNode =>
    nodes.map(({ folder, children }) => {
      const hasChildren = children.length > 0;
      const open = hasChildren && isOpen(folder.id);
      const restricted = folder.restricted || inherited;
      return item(
        folder.id,
        level,
        <>
          <span className="truncate">{folder.name}</span>
          {restricted ? (
            <span className="folder-tree__restricted">
              <Icon name="lock" />
              <span className="visually-hidden">{`, ${t("dashboards.folders.restricted")}`}</span>
            </span>
          ) : null}
        </>,
        "folder",
        {
          hasChildren,
          open,
          title: folder.restricted
            ? t("dashboards.folders.restrictedHint")
            : inherited
              ? t("dashboards.folders.restrictedInheritedHint")
              : undefined,
        },
        open ? renderNodes(children, level + 1, restricted) : null,
      );
    });

  return (
    <nav className="folder-tree" aria-labelledby={`${ids}-heading`}>
      <div className="folder-tree__head">
        <span className="folder-tree__heading" id={`${ids}-heading`}>
          {t("dashboards.folders.label")}
        </span>
        {withChildren.length === 0 ? null : (
          <button
            type="button"
            className="folder-tree__fold-all"
            disabled={withChildren.every((f) => !isOpen(f.id) || path.includes(f.id))}
            onClick={() => fold(withChildren.map((f) => f.id))}
          >
            {t("dashboards.folders.foldAll")}
          </button>
        )}
      </div>
      <div
        ref={treeRef}
        role="tree"
        className="folder-tree__list folder-tree__tree"
        aria-labelledby={`${ids}-heading`}
        onKeyDown={onKeyDown}
      >
        {item(
          ALL,
          1,
          <span className="truncate">{t("dashboards.folders.all")}</span>,
          "dashboards",
          { hasChildren: false, open: false },
          null,
        )}
        {renderNodes(tree, 1)}
      </div>
    </nav>
  );
}
