import * as vscode from 'vscode'
import type { FileGroups, FileRow } from './file-list.js'

/**
 * The changed-file list, as a native tree.
 *
 * It is a TreeView rather than part of the webview for one decisive reason: file
 * icon themes are only available to native tree items. A webview cannot read the
 * user's icon theme at all, so a list drawn in HTML can never show the same
 * icons as the rest of the workbench. Handing each item a `resourceUri` gets the
 * icon, the git decoration colour, and the status badge for free, and keeps
 * keyboard navigation and context menus native.
 */

export type Node = GroupNode | FileNode

export interface GroupNode {
  kind: 'group'
  id: 'staged' | 'changes'
  label: string
  rows: FileRow[]
}

export interface FileNode {
  kind: 'file'
  row: FileRow
  group: 'staged' | 'changes'
}

export class ChangesTree implements vscode.TreeDataProvider<Node> {
  static readonly viewId = 'unbraid.changes'

  private groups: FileGroups | null = null
  private root: string | null = null

  private readonly changed = new vscode.EventEmitter<Node | undefined>()
  readonly onDidChangeTreeData = this.changed.event

  update(groups: FileGroups | null, root: string | null): void {
    this.groups = groups
    this.root = root
    this.changed.fire(undefined)
  }

  getChildren(node?: Node): Node[] {
    if (!this.groups) return []

    if (!node) {
      const sections: GroupNode[] = []
      if (this.groups.staged.length > 0) {
        sections.push({
          kind: 'group',
          id: 'staged',
          label: 'Staged',
          rows: this.groups.staged,
        })
      }
      sections.push({
        kind: 'group',
        id: 'changes',
        label: 'Changes',
        rows: this.groups.changes,
      })
      return sections
    }

    if (node.kind === 'group') {
      return node.rows.map((row) => ({ kind: 'file', row, group: node.id }))
    }
    return []
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(
        node.label,
        vscode.TreeItemCollapsibleState.Expanded,
      )
      item.description = String(node.rows.length)
      // Drives which bulk actions the section header offers.
      item.contextValue = `group-${node.id}`
      return item
    }

    const { row } = node
    const item = new vscode.TreeItem(row.name)

    if (this.root) {
      // The resourceUri is what earns the file-type icon from the user's icon
      // theme and the git decoration colour, so it is set even for a collapsed
      // directory that has no single file behind it.
      item.resourceUri = vscode.Uri.joinPath(vscode.Uri.file(this.root), row.path)
    }

    item.description = row.collapsed ? `${row.dir} · ${row.collapsed} files` : row.dir
    item.tooltip = `${row.path} — ${describeStatus(row)}`
    item.contextValue = node.group === 'staged' ? 'staged-file' : 'unstaged-file'

    // Clicking opens the diff rather than the file: in a list of changes, the
    // change is what you came to look at.
    item.command = {
      command: 'unbraid.openChange',
      title: 'Open change',
      arguments: [row.path],
    }

    return item
  }
}

function describeStatus(row: FileRow): string {
  const counts =
    row.insertions || row.deletions ? ` (+${row.insertions}/-${row.deletions})` : ''
  return `${row.status}${counts}`
}
