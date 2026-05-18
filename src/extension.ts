import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import type { GitExtension, API as GitAPI, Repository } from './types/git';

const execAsync = promisify(exec);

// Utility functions
async function getFileContext(uri?: vscode.Uri) {
    const filePath = uri?.fsPath || vscode.window.activeTextEditor?.document.fileName;
    if (!filePath) {
        vscode.window.showErrorMessage('No file selected');
        return null;
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri || vscode.Uri.file(filePath));
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('File is not in a workspace');
        return null;
    }

    return { filePath, workspaceFolder };
}

async function openDiffView(oldUri: vscode.Uri, newUri: vscode.Uri, title: string, workspaceFolder: vscode.WorkspaceFolder, lineNumber?: number) {
    const provider = {
        async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
            try {
                const { stdout } = await execAsync(`git show ${uri.query}:"${uri.path}"`, {
                    cwd: workspaceFolder.uri.fsPath
                });
                return stdout;
            } catch (error) {
                return `Error loading content: ${error}`;
            }
        }
    };

    const disposable = vscode.workspace.registerTextDocumentContentProvider('git-show', provider);

    try {
        await vscode.commands.executeCommand('vscode.diff', oldUri, newUri, title);

        // Preserve cursor position if lineNumber is provided
        if (lineNumber !== undefined) {
            setTimeout(async () => {
                const activeEditor = vscode.window.activeTextEditor;
                if (activeEditor) {
                    const position = new vscode.Position(lineNumber, 0);
                    activeEditor.selection = new vscode.Selection(position, position);
                    activeEditor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
                }
            }, 100);
        }
    } finally {
        setTimeout(() => disposable.dispose(), 10000);
    }
}

function createGitUri(relativePath: string, hash: string): vscode.Uri {
    return vscode.Uri.from({
        scheme: 'git-show',
        path: relativePath,
        query: hash
    });
}

function normalizeRemoteUrl(remoteUrl: string): string {
    let webUrl = remoteUrl;

    if (webUrl.startsWith('git@')) {
        webUrl = webUrl.replace(/^git@([^:]+):/, 'https://$1/');
    } else if (webUrl.startsWith('ssh://git@')) {
        webUrl = webUrl.replace(/^ssh:\/\/git@/, 'https://');
    }

    return webUrl.replace(/\.git$/, '');
}

function constructFileUrl(webUrl: string, branch: string, relativePath: string, lineNumber?: number, endLineNumber?: number): string {
    let fileUrl: string;

    if (webUrl.includes('github.com')) {
        fileUrl = `${webUrl}/blob/${branch}/${relativePath}`;
        if (lineNumber) {
            fileUrl += `#L${lineNumber}`;
            if (endLineNumber && endLineNumber !== lineNumber) fileUrl += `-L${endLineNumber}`;
        }
    } else if (webUrl.includes('gitlab.com')) {
        fileUrl = `${webUrl}/-/blob/${branch}/${relativePath}`;
        if (lineNumber) fileUrl += `#L${lineNumber}`;
    } else if (webUrl.includes('bitbucket.org')) {
        fileUrl = `${webUrl}/src/${branch}/${relativePath}`;
        if (lineNumber) fileUrl += `#lines-${lineNumber}`;
    } else {
        fileUrl = `${webUrl}/blob/${branch}/${relativePath}`;
    }

    return fileUrl;
}

function constructCommitUrl(webUrl: string, hash: string): string {
    if (webUrl.includes('bitbucket.org')) return `${webUrl}/commits/${hash}`;
    if (webUrl.includes('gitlab.com')) return `${webUrl}/-/commit/${hash}`;
    return `${webUrl}/commit/${hash}`;
}

function constructPrUrl(webUrl: string, prNumber: string): string {
    if (webUrl.includes('bitbucket.org')) return `${webUrl}/pull-requests/${prNumber}`;
    if (webUrl.includes('gitlab.com')) return `${webUrl}/-/merge_requests/${prNumber}`;
    return `${webUrl}/pull/${prNumber}`;
}

async function selectRevision(branches: string[]) {
    const items = branches.map(branch => {
        const [hash, ...messageParts] = branch.split(' ');
        return {
            label: hash,
            description: messageParts.join(' '),
            hash: hash
        };
    });

    const quickPick = vscode.window.createQuickPick();
    quickPick.items = items;
    quickPick.placeholder = 'Select a revision or type custom one (commit hash, branch name, etc.)';
    quickPick.canSelectMany = false;

    return new Promise<{hash: string} | undefined>((resolve) => {
        quickPick.onDidAccept(() => {
            const selected = quickPick.selectedItems[0];
            if (selected) {
                const originalItem = items.find(item => item.label === selected.label);
                resolve(originalItem);
            } else if (quickPick.value) {
                resolve({ hash: quickPick.value });
            } else {
                resolve(undefined);
            }
            quickPick.dispose();
        });

        quickPick.onDidHide(() => {
            resolve(undefined);
            quickPick.dispose();
        });

        quickPick.show();
    });
}

// Command implementations
async function compareWithRevision(uri?: vscode.Uri) {
    const context = await getFileContext(uri);
    if (!context) return;

    const { filePath, workspaceFolder } = context;

    try {
        const { stdout } = await execAsync(
            `git branch --format='%(refname:short)' --sort=-committerdate`,
            { cwd: workspaceFolder.uri.fsPath }
        );

        const branches = stdout.trim().split('\n').filter(line => line.trim());
        if (branches.length === 0) {
            vscode.window.showInformationMessage('No commits found for this file');
            return;
        }

        // Capture current cursor position
        const editor = vscode.window.activeTextEditor;
        const currentLine = editor?.document.fileName === filePath
            ? editor.selection.active.line
            : undefined;

        const selectedItem = await selectRevision(branches);
        if (!selectedItem) return;

        const relativePath = path.relative(workspaceFolder.uri.fsPath, filePath);
        const oldUri = createGitUri(relativePath, selectedItem.hash);
        const newUri = vscode.Uri.file(filePath);
        const title = `${path.basename(filePath)} (${selectedItem.hash}) ↔ ${path.basename(filePath)} (Working Tree)`;

        await openDiffView(oldUri, newUri, title, workspaceFolder, currentLine);
    } catch (error) {
        vscode.window.showErrorMessage(`${error}`);
    }
}

async function openRemote(uri?: vscode.Uri) {
    const context = await getFileContext(uri);
    if (!context) return;

    const { filePath, workspaceFolder } = context;

    try {
        const [remoteResult, branchResult] = await Promise.all([
            execAsync('git config --get remote.origin.url', { cwd: workspaceFolder.uri.fsPath }),
            execAsync('git branch --show-current', { cwd: workspaceFolder.uri.fsPath })
        ]);

        const remoteUrl = remoteResult.stdout.trim();
        const branch = branchResult.stdout.trim();
        const relativePath = path.relative(workspaceFolder.uri.fsPath, filePath);
        const webUrl = normalizeRemoteUrl(remoteUrl);

        // Get line range if in editor
        const editor = vscode.window.activeTextEditor;
        let startLine: number | undefined;
        let endLine: number | undefined;
        if (editor?.document.fileName === filePath) {
            startLine = editor.selection.start.line + 1;
            endLine = editor.selection.end.line + 1;
            if (editor.selection.isEmpty) endLine = startLine;
            else if (editor.selection.end.character === 0) endLine = Math.max(startLine, endLine - 1);
        }

        const fileUrl = constructFileUrl(webUrl, branch, relativePath, startLine, endLine);
        await vscode.env.openExternal(vscode.Uri.parse(fileUrl));
    } catch (error) {
        vscode.window.showErrorMessage(`${error}`);
    }
}

async function openRemoteMain(uri?: vscode.Uri) {
    const context = await getFileContext(uri);
    if (!context) return;

    const { filePath, workspaceFolder } = context;

    try {
        const { stdout: remoteUrl } = await execAsync('git config --get remote.origin.url', {
            cwd: workspaceFolder.uri.fsPath
        });

        const relativePath = path.relative(workspaceFolder.uri.fsPath, filePath);
        const webUrl = normalizeRemoteUrl(remoteUrl.trim());

        // Get line range if in editor
        const editor = vscode.window.activeTextEditor;
        let startLine: number | undefined;
        let endLine: number | undefined;
        if (editor?.document.fileName === filePath) {
            startLine = editor.selection.start.line + 1;
            endLine = editor.selection.end.line + 1;
            if (editor.selection.isEmpty) endLine = startLine;
            else if (editor.selection.end.character === 0) endLine = Math.max(startLine, endLine - 1);
        }

        const fileUrl = constructFileUrl(webUrl, 'main', relativePath, startLine, endLine);
        await vscode.env.openExternal(vscode.Uri.parse(fileUrl));
    } catch (error) {
        vscode.window.showErrorMessage(`${error}`);
    }
}

// Merge-base changes tree view
const TREE_SCHEME = 'light-git-mb';
const EMPTY_SCHEME = 'light-git-empty';

type ChangeStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U';

const STATUS_DECORATIONS: Record<ChangeStatus, { tooltip: string; color: string }> = {
    A: { tooltip: 'Added', color: 'gitDecoration.addedResourceForeground' },
    M: { tooltip: 'Modified', color: 'gitDecoration.modifiedResourceForeground' },
    D: { tooltip: 'Deleted', color: 'gitDecoration.deletedResourceForeground' },
    R: { tooltip: 'Renamed', color: 'gitDecoration.renamedResourceForeground' },
    C: { tooltip: 'Copied', color: 'gitDecoration.renamedResourceForeground' },
    T: { tooltip: 'Type Changed', color: 'gitDecoration.modifiedResourceForeground' },
    U: { tooltip: 'Untracked', color: 'gitDecoration.untrackedResourceForeground' },
};

function normalizeStatus(raw: string): ChangeStatus {
    const c = raw[0];
    if (c === 'A' || c === 'M' || c === 'D' || c === 'R' || c === 'C' || c === 'T' || c === 'U') return c;
    return 'M';
}

function parseNameStatus(stdout: string): Array<{ status: ChangeStatus; relativePath: string }> {
    const tokens = stdout.split('\0').filter(t => t.length > 0);
    const result: Array<{ status: ChangeStatus; relativePath: string }> = [];
    let i = 0;
    while (i < tokens.length) {
        const raw = tokens[i++];
        const status = normalizeStatus(raw);
        if (raw[0] === 'R' || raw[0] === 'C') {
            i++; // skip old path
            const newPath = tokens[i++];
            if (newPath !== undefined) result.push({ status, relativePath: newPath });
        } else {
            const p = tokens[i++];
            if (p !== undefined) result.push({ status, relativePath: p });
        }
    }
    return result;
}

type FileNode = {
    kind: 'file';
    basename: string;
    absolutePath: string;
    relativePath: string;
    status: ChangeStatus;
};

type FolderNode = {
    kind: 'folder';
    segments: string[];
    absolutePath: string;
    children: TreeNode[];
};

type TreeNode = FileNode | FolderNode;

type RawFolder = {
    kind: 'folder';
    segment: string;
    children: Map<string, RawNode>;
};

type RawFile = {
    kind: 'file';
    basename: string;
    absolutePath: string;
    relativePath: string;
    status: ChangeStatus;
};

type RawNode = RawFolder | RawFile;

function buildRawTree(entries: Array<{ status: ChangeStatus; relativePath: string }>, rootPath: string): RawFolder {
    const root: RawFolder = { kind: 'folder', segment: '', children: new Map() };
    for (const { status, relativePath } of entries) {
        const parts = relativePath.split('/');
        let node = root;
        for (let i = 0; i < parts.length - 1; i++) {
            const seg = parts[i];
            const existing = node.children.get(seg);
            let child: RawFolder;
            if (existing && existing.kind === 'folder') {
                child = existing;
            } else {
                child = { kind: 'folder', segment: seg, children: new Map() };
                node.children.set(seg, child);
            }
            node = child;
        }
        const fname = parts[parts.length - 1];
        node.children.set(fname, {
            kind: 'file',
            basename: fname,
            absolutePath: path.join(rootPath, relativePath),
            relativePath,
            status,
        });
    }
    return root;
}

function finalizeFolder(raw: RawFolder, parentAbsolutePath: string, compact: boolean): FolderNode {
    const segments: string[] = raw.segment ? [raw.segment] : [];
    let current = raw;

    if (compact) {
        while (current.children.size === 1) {
            const [only] = current.children.values();
            if (only.kind !== 'folder') break;
            segments.push(only.segment);
            current = only;
        }
    }

    const folderAbsolutePath = segments.length === 0
        ? parentAbsolutePath
        : path.join(parentAbsolutePath, ...segments);

    const folderEntries: RawFolder[] = [];
    const fileEntries: RawFile[] = [];
    for (const c of current.children.values()) {
        if (c.kind === 'folder') folderEntries.push(c);
        else fileEntries.push(c);
    }
    folderEntries.sort((a, b) => a.segment.localeCompare(b.segment));
    fileEntries.sort((a, b) => a.basename.localeCompare(b.basename));

    const children: TreeNode[] = [
        ...folderEntries.map(f => finalizeFolder(f, folderAbsolutePath, compact)),
        ...fileEntries.map<FileNode>(f => ({
            kind: 'file',
            basename: f.basename,
            absolutePath: f.absolutePath,
            relativePath: f.relativePath,
            status: f.status,
        })),
    ];

    return { kind: 'folder', segments, absolutePath: folderAbsolutePath, children };
}

class MergeBaseDecorationProvider implements vscode.FileDecorationProvider {
    private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();
    readonly onDidChangeFileDecorations = this._onDidChange.event;

    private statusByPath = new Map<string, ChangeStatus>();

    update(next: Map<string, ChangeStatus>) {
        const changedPaths = new Set<string>();
        for (const [p, s] of this.statusByPath) {
            if (next.get(p) !== s) changedPaths.add(p);
        }
        for (const [p, s] of next) {
            if (this.statusByPath.get(p) !== s) changedPaths.add(p);
        }
        this.statusByPath = next;
        if (changedPaths.size === 0) return;
        const uris = [...changedPaths].map(p => vscode.Uri.from({ scheme: TREE_SCHEME, path: p }));
        this._onDidChange.fire(uris);
    }

    provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        if (uri.scheme !== TREE_SCHEME) return undefined;
        const status = this.statusByPath.get(uri.path);
        if (!status) return undefined;
        const meta = STATUS_DECORATIONS[status];
        return {
            badge: status,
            tooltip: meta.tooltip,
            color: new vscode.ThemeColor(meta.color),
            propagate: false,
        };
    }
}

class MergeBaseChangesProvider implements vscode.TreeDataProvider<TreeNode> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private root: FolderNode | undefined;
    private view: vscode.TreeView<TreeNode> | undefined;
    mergeBaseHash: string | undefined;

    constructor(private readonly decorations: MergeBaseDecorationProvider) {}

    setView(view: vscode.TreeView<TreeNode>) {
        this.view = view;
    }

    async refresh(): Promise<void> {
        await this.compute();
        this._onDidChangeTreeData.fire();
    }

    private setMessage(msg: string | undefined) {
        if (this.view) this.view.message = msg;
    }

    private async compute(): Promise<void> {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            this.root = undefined;
            this.mergeBaseHash = undefined;
            this.decorations.update(new Map());
            this.setMessage('No workspace folder open.');
            return;
        }
        const cwd = folders[0].uri.fsPath;

        let mergeBase: string;
        try {
            const { stdout } = await execAsync('git merge-base HEAD main', { cwd });
            mergeBase = stdout.trim();
        } catch {
            this.root = undefined;
            this.mergeBaseHash = undefined;
            this.decorations.update(new Map());
            this.setMessage('Not a git repository, or no merge-base with main.');
            return;
        }
        this.mergeBaseHash = mergeBase;

        let entries: Array<{ status: ChangeStatus; relativePath: string }>;
        try {
            const { stdout } = await execAsync(
                `git diff --name-status -z ${mergeBase}`,
                { cwd, maxBuffer: 32 * 1024 * 1024 }
            );
            entries = parseNameStatus(stdout);
        } catch (err) {
            this.root = undefined;
            this.decorations.update(new Map());
            this.setMessage(`Failed to list changed files: ${err}`);
            return;
        }

        if (entries.length === 0) {
            this.root = undefined;
            this.decorations.update(new Map());
            this.setMessage('No files changed vs main.');
            return;
        }

        const compact = vscode.workspace.getConfiguration('scm').get<boolean>('compactFolders', true);
        const raw = buildRawTree(entries, cwd);
        this.root = finalizeFolder(raw, cwd, compact);

        const statusMap = new Map<string, ChangeStatus>();
        for (const { status, relativePath } of entries) {
            statusMap.set(path.join(cwd, relativePath), status);
        }
        this.decorations.update(statusMap);

        this.setMessage(undefined);
    }

    getTreeItem(element: TreeNode): vscode.TreeItem {
        if (element.kind === 'folder') {
            const item = new vscode.TreeItem(
                element.segments.join('/'),
                vscode.TreeItemCollapsibleState.Expanded
            );
            item.resourceUri = vscode.Uri.from({ scheme: TREE_SCHEME, path: element.absolutePath });
            item.iconPath = vscode.ThemeIcon.Folder;
            return item;
        }
        const item = new vscode.TreeItem(element.basename, vscode.TreeItemCollapsibleState.None);
        item.resourceUri = vscode.Uri.from({ scheme: TREE_SCHEME, path: element.absolutePath });
        item.iconPath = vscode.ThemeIcon.File;
        item.tooltip = element.relativePath;
        item.contextValue = element.status === 'D' ? 'lightGitFileDeleted' : 'lightGitFile';
        item.command = {
            command: 'lightGit.openMergeBaseDiff',
            title: 'Open Merge-base Diff',
            arguments: [element.absolutePath, this.mergeBaseHash, element.status],
        };
        return item;
    }

    getChildren(element?: TreeNode): TreeNode[] {
        if (!element) return this.root?.children ?? [];
        if (element.kind === 'folder') return element.children;
        return [];
    }
}

function createEmptyUri(displayPath: string): vscode.Uri {
    return vscode.Uri.from({ scheme: EMPTY_SCHEME, path: displayPath });
}

async function openChangedFile(target: FileNode | vscode.Uri | string | undefined) {
    if (!target) return;
    let absolutePath: string;
    if (typeof target === 'string') absolutePath = target;
    else if (target instanceof vscode.Uri) absolutePath = target.fsPath;
    else absolutePath = target.absolutePath;
    if (!absolutePath) return;
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(absolutePath));
}

async function openMergeBaseDiff(absolutePath: string, mergeBaseHash: string, status: ChangeStatus) {
    if (!absolutePath || !mergeBaseHash) return;
    const fileUri = vscode.Uri.file(absolutePath);
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri)
        ?? vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('File is not in a workspace');
        return;
    }
    const relativePath = path.relative(workspaceFolder.uri.fsPath, absolutePath);
    const baseName = path.basename(absolutePath);
    const shortHash = mergeBaseHash.slice(0, 7);

    let oldUri: vscode.Uri;
    let newUri: vscode.Uri;
    let title: string;

    if (status === 'A') {
        oldUri = createEmptyUri(relativePath);
        newUri = fileUri;
        title = `${baseName} (Added) ↔ ${baseName} (Working Tree)`;
    } else if (status === 'D') {
        oldUri = createGitUri(relativePath, mergeBaseHash);
        newUri = createEmptyUri(relativePath);
        title = `${baseName} (${shortHash}) ↔ ${baseName} (Deleted)`;
    } else {
        oldUri = createGitUri(relativePath, mergeBaseHash);
        newUri = fileUri;
        title = `${baseName} (${shortHash}) ↔ ${baseName} (Working Tree)`;
    }

    await openDiffView(oldUri, newUri, title, workspaceFolder);
}

async function getGitAPI(): Promise<GitAPI | undefined> {
    const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!ext) return undefined;
    const exports = ext.isActive ? ext.exports : await ext.activate();
    if (!exports.enabled) return undefined;
    return exports.getAPI(1);
}

async function copyLineRangePath() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No active editor');
        return;
    }
    const document = editor.document;
    const selection = editor.selection;

    let startLine = selection.start.line + 1;
    let endLine = selection.end.line + 1;

    if (selection.isEmpty) {
        endLine = startLine;
    } else if (selection.end.character === 0) {
        endLine = Math.max(startLine, endLine - 1);
    }

    if (startLine > endLine) {
        [startLine, endLine] = [endLine, startLine];
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('File is not in a workspace');
        return;
    }

    const relativePath = path.relative(workspaceFolder.uri.fsPath, document.fileName);
    const rangeSpec = `-L${startLine},${endLine}:${relativePath}`;
    await vscode.env.clipboard.writeText(rangeSpec);
}

// Selection History view
function getSelectedLineRange(editor: vscode.TextEditor): { startLine: number; endLine: number } {
    let startLine = editor.selection.start.line + 1;
    let endLine = editor.selection.end.line + 1;
    if (editor.selection.isEmpty) {
        endLine = startLine;
    } else if (editor.selection.end.character === 0) {
        endLine = Math.max(startLine, endLine - 1);
    }
    if (startLine > endLine) [startLine, endLine] = [endLine, startLine];
    return { startLine, endLine };
}

function toGitPath(relativePath: string): string {
    return relativePath.split(path.sep).join('/');
}

type SelectionKind = 'range' | 'file';

type SelectionCommit = {
    fullHash: string;
    shortHash: string;
    subject: string;
    author: string;
    date: string;
    oldPath: string;
    newPath: string;
    oldContent: string;
    newContent: string;
    kind: SelectionKind;
};

type SelectionQuery = {
    workspaceFolder: vscode.WorkspaceFolder;
    relativePath: string;
    startLine: number;
    endLine: number;
    kind: SelectionKind;
};

const PR_NUMBER_RE = /\(#(\d+)\)\s*$/;
const SELECTION_DIFF_SCHEME = 'light-git-selection';

function parseHunkPatch(patch: string): { oldPath: string; newPath: string; oldContent: string; newContent: string } {
    let oldPath = '';
    let newPath = '';
    const oldLines: string[] = [];
    const newLines: string[] = [];
    let inHunk = false;
    let firstHunk = true;

    for (const line of patch.split('\n')) {
        if (line.startsWith('--- ')) {
            const p = line.slice(4).trim();
            oldPath = p === '/dev/null' ? '' : p.replace(/^a\//, '');
            inHunk = false;
        } else if (line.startsWith('+++ ')) {
            const p = line.slice(4).trim();
            newPath = p === '/dev/null' ? '' : p.replace(/^b\//, '');
            inHunk = false;
        } else if (line.startsWith('@@ ')) {
            inHunk = true;
            if (!firstHunk) {
                oldLines.push('');
                newLines.push('');
            }
            firstHunk = false;
        } else if (inHunk && line.length > 0) {
            const prefix = line[0];
            const content = line.slice(1);
            if (prefix === ' ') {
                oldLines.push(content);
                newLines.push(content);
            } else if (prefix === '-') {
                oldLines.push(content);
            } else if (prefix === '+') {
                newLines.push(content);
            }
        }
    }

    return {
        oldPath,
        newPath,
        oldContent: oldLines.join('\n'),
        newContent: newLines.join('\n'),
    };
}

function parseNameStatusEntry(line: string, fallbackPath: string): { oldPath: string; newPath: string } {
    const parts = line.split('\t');
    const code = parts[0] ?? '';
    if (code.startsWith('R') || code.startsWith('C')) {
        return { oldPath: parts[1] ?? '', newPath: parts[2] ?? '' };
    }
    if (code === 'D') {
        return { oldPath: parts[1] ?? fallbackPath, newPath: '' };
    }
    if (code === 'A') {
        return { oldPath: '', newPath: parts[1] ?? fallbackPath };
    }
    const p = parts[1] ?? fallbackPath;
    return { oldPath: p, newPath: p };
}

async function runSelectionLog(query: SelectionQuery): Promise<SelectionCommit[]> {
    const gitPath = toGitPath(query.relativePath);
    const cmd = query.kind === 'file'
        ? `git log --follow --name-status --format=format:%x00%H%x1f%h%x1f%s%x1f%an%x1f%ad --date=short -- "${gitPath}"`
        : `git log -L${query.startLine},${query.endLine}:"${gitPath}" --format=format:%x00%H%x1f%h%x1f%s%x1f%an%x1f%ad --date=short`;
    const { stdout } = await execAsync(cmd, {
        cwd: query.workspaceFolder.uri.fsPath,
        maxBuffer: 32 * 1024 * 1024,
    });
    const blocks = stdout.split('\0').filter(b => b.length > 0);
    const commits: SelectionCommit[] = [];
    for (const block of blocks) {
        const newlineIdx = block.indexOf('\n');
        const metadata = newlineIdx === -1 ? block : block.slice(0, newlineIdx);
        const remainder = newlineIdx === -1 ? '' : block.slice(newlineIdx + 1);
        const parts = metadata.split('\x1f');
        if (parts.length < 5) continue;
        const [fullHash, shortHash, subject, author, date] = parts;
        if (query.kind === 'file') {
            const statusLine = remainder.split('\n').find((l: string) => l.length > 0) ?? '';
            const { oldPath, newPath } = parseNameStatusEntry(statusLine, gitPath);
            commits.push({ fullHash, shortHash, subject, author, date, oldPath, newPath, oldContent: '', newContent: '', kind: 'file' });
        } else {
            const { oldPath, newPath, oldContent, newContent } = parseHunkPatch(remainder);
            commits.push({ fullHash, shortHash, subject, author, date, oldPath, newPath, oldContent, newContent, kind: 'range' });
        }
    }
    return commits;
}

class SelectionDiffContentProvider implements vscode.TextDocumentContentProvider {
    private cache = new Map<string, string>();

    set(uri: vscode.Uri, content: string) {
        this.cache.set(uri.toString(), content);
    }

    provideTextDocumentContent(uri: vscode.Uri): string {
        return this.cache.get(uri.toString()) ?? '';
    }
}

type SelectionDiffMode = 'hunk' | 'full';
type SelectionDiffSide = 'before' | 'after';

function createSelectionDiffUri(opts: {
    filePath: string;
    hash: string;
    side: SelectionDiffSide;
    mode: SelectionDiffMode;
    kind: SelectionKind;
}): vscode.Uri {
    const params = new URLSearchParams({ hash: opts.hash, side: opts.side, mode: opts.mode, kind: opts.kind });
    return vscode.Uri.from({
        scheme: SELECTION_DIFF_SCHEME,
        path: opts.filePath || '(empty).txt',
        query: params.toString(),
    });
}

function parseSelectionDiffUri(uri: vscode.Uri): { hash: string; side: SelectionDiffSide; mode: SelectionDiffMode; kind: SelectionKind } | undefined {
    if (uri.scheme !== SELECTION_DIFF_SCHEME) return undefined;
    const params = new URLSearchParams(uri.query);
    const hash = params.get('hash');
    const side = params.get('side');
    const mode = params.get('mode');
    const kind = params.get('kind');
    if (!hash) return undefined;
    if (side !== 'before' && side !== 'after') return undefined;
    if (mode !== 'hunk' && mode !== 'full') return undefined;
    if (kind !== 'range' && kind !== 'file') return undefined;
    return { hash, side, mode, kind };
}

function getActiveSelectionDiff(): { hash: string; mode: SelectionDiffMode; kind: SelectionKind } | undefined {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (!(input instanceof vscode.TabInputTextDiff)) return undefined;
    const parsed = parseSelectionDiffUri(input.modified);
    return parsed ? { hash: parsed.hash, mode: parsed.mode, kind: parsed.kind } : undefined;
}

function updateSelectionDiffContext() {
    const info = getActiveSelectionDiff();
    void vscode.commands.executeCommand('setContext', 'lightGit.selectionDiffMode', info?.mode ?? '');
    void vscode.commands.executeCommand('setContext', 'lightGit.selectionDiffKind', info?.kind ?? '');
}

class SelectionHistoryProvider implements vscode.TreeDataProvider<SelectionCommit> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<SelectionCommit | undefined | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private view: vscode.TreeView<SelectionCommit> | undefined;
    commits: SelectionCommit[] = [];
    query: SelectionQuery | undefined;

    setView(view: vscode.TreeView<SelectionCommit>) {
        this.view = view;
        this.setMessage('Select lines and run "Show Selection History".');
    }

    async revealCommit(commit: SelectionCommit) {
        if (!this.view) return;
        try {
            await this.view.reveal(commit, { select: true, focus: false, expand: false });
        } catch {
            // ignore reveal failures
        }
    }

    private setMessage(msg: string | undefined) {
        if (this.view) this.view.message = msg;
    }

    async setQuery(query: SelectionQuery): Promise<void> {
        this.query = query;
        await this.refresh();
    }

    async refresh(): Promise<void> {
        if (!this.query) {
            this.commits = [];
            this.setMessage('Select lines and run "Show Selection History".');
            this._onDidChangeTreeData.fire();
            return;
        }
        try {
            this.commits = await runSelectionLog(this.query);
        } catch (err) {
            this.commits = [];
            this.setMessage(`Failed to load history: ${err}`);
            this._onDidChangeTreeData.fire();
            return;
        }
        if (this.commits.length === 0) {
            this.setMessage('No history found for this selection.');
        } else if (this.query.kind === 'file') {
            this.setMessage(`${this.query.relativePath} — full history`);
        } else {
            const { relativePath, startLine, endLine } = this.query;
            this.setMessage(`${relativePath} L${startLine}-${endLine}`);
        }
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(c: SelectionCommit): vscode.TreeItem {
        const item = new vscode.TreeItem(c.subject, vscode.TreeItemCollapsibleState.None);
        item.description = `${c.date} · ${c.author}`;
        item.iconPath = new vscode.ThemeIcon('git-commit');
        item.contextValue = 'lightGitSelectionCommit';
        const md = new vscode.MarkdownString();
        md.appendMarkdown('**');
        md.appendText(c.subject);
        md.appendMarkdown('**\n\n');
        md.appendCodeblock(c.fullHash, 'text');
        md.appendText(`${c.author} — ${c.date}`);
        item.tooltip = md;
        item.command = c.kind === 'file'
            ? { command: 'lightGit.openSelectionCommitFullDiff', title: 'Open Full File Diff', arguments: [c] }
            : { command: 'lightGit.openSelectionCommitDiff', title: 'Open Commit Diff', arguments: [c] };
        return item;
    }

    getChildren(): SelectionCommit[] {
        return this.commits;
    }

    getParent(): SelectionCommit | undefined {
        return undefined;
    }
}

async function showSelectionHistory(provider: SelectionHistoryProvider) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No active editor');
        return;
    }
    const kind: SelectionKind = editor.selection.isEmpty ? 'file' : 'range';
    const { startLine, endLine } = getSelectedLineRange(editor);
    const document = editor.document;
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('File is not in a workspace');
        return;
    }
    const relativePath = path.relative(workspaceFolder.uri.fsPath, document.fileName);
    await provider.setQuery({ workspaceFolder, relativePath, startLine, endLine, kind });
    await vscode.commands.executeCommand('lightGit.selectionHistory.focus');
}

async function openSelectionCommitDiff(diffProvider: SelectionDiffContentProvider, commit: SelectionCommit) {
    if (!commit) return;
    const displayOld = commit.oldPath || commit.newPath;
    const displayNew = commit.newPath || commit.oldPath;
    const oldUri = createSelectionDiffUri({ filePath: displayOld, hash: commit.fullHash, side: 'before', mode: 'hunk', kind: commit.kind });
    const newUri = createSelectionDiffUri({ filePath: displayNew, hash: commit.fullHash, side: 'after', mode: 'hunk', kind: commit.kind });
    diffProvider.set(oldUri, commit.oldContent);
    diffProvider.set(newUri, commit.newContent);

    const oldBase = path.basename(displayOld);
    const newBase = path.basename(displayNew);
    const isRename = !!commit.oldPath && !!commit.newPath && commit.oldPath !== commit.newPath;
    const leftLabel = commit.oldPath ? `${commit.shortHash}^` : 'Added';
    const title = isRename
        ? `${oldBase} (${leftLabel}) ↔ ${newBase} (${commit.shortHash}) — selection`
        : `${newBase} (${leftLabel}) ↔ ${newBase} (${commit.shortHash}) — selection`;

    await vscode.commands.executeCommand('vscode.diff', oldUri, newUri, title);
}

async function fetchGitShow(workspaceFolder: vscode.WorkspaceFolder, rev: string, gitPath: string): Promise<string> {
    try {
        const { stdout } = await execAsync(`git show ${rev}:"${gitPath}"`, {
            cwd: workspaceFolder.uri.fsPath,
            maxBuffer: 32 * 1024 * 1024,
        });
        return stdout;
    } catch {
        return '';
    }
}

async function openSelectionCommitFullDiff(provider: SelectionHistoryProvider, diffProvider: SelectionDiffContentProvider, commit: SelectionCommit) {
    if (!commit) return;
    const query = provider.query;
    if (!query) return;
    const { workspaceFolder } = query;

    const oldPath = commit.oldPath;
    const newPath = commit.newPath || query.relativePath;
    const displayOld = oldPath || newPath;
    const displayNew = newPath || oldPath;

    const oldContent = oldPath
        ? await fetchGitShow(workspaceFolder, `${commit.fullHash}^`, toGitPath(oldPath))
        : '';
    const newContent = commit.newPath
        ? await fetchGitShow(workspaceFolder, commit.fullHash, toGitPath(commit.newPath))
        : '';

    const oldUri = createSelectionDiffUri({ filePath: displayOld, hash: commit.fullHash, side: 'before', mode: 'full', kind: commit.kind });
    const newUri = createSelectionDiffUri({ filePath: displayNew, hash: commit.fullHash, side: 'after', mode: 'full', kind: commit.kind });
    diffProvider.set(oldUri, oldContent);
    diffProvider.set(newUri, newContent);

    const oldBase = path.basename(displayOld);
    const newBase = path.basename(displayNew);
    const isRename = !!oldPath && !!commit.newPath && oldPath !== commit.newPath;
    const leftLabel = oldPath ? `${commit.shortHash}^` : 'Added';
    const title = isRename
        ? `${oldBase} (${leftLabel}) ↔ ${newBase} (${commit.shortHash})`
        : `${newBase} (${leftLabel}) ↔ ${newBase} (${commit.shortHash})`;

    await vscode.commands.executeCommand('vscode.diff', oldUri, newUri, title);
}

async function toggleSelectionDiffMode(provider: SelectionHistoryProvider, diffProvider: SelectionDiffContentProvider) {
    const active = getActiveSelectionDiff();
    if (!active) return;
    const commit = provider.commits.find(c => c.fullHash === active.hash);
    if (!commit) return;
    if (active.mode === 'hunk') {
        await openSelectionCommitFullDiff(provider, diffProvider, commit);
    } else {
        await openSelectionCommitDiff(diffProvider, commit);
    }
}

async function navigateSelectionDiff(provider: SelectionHistoryProvider, diffProvider: SelectionDiffContentProvider, direction: 'prev' | 'next') {
    const active = getActiveSelectionDiff();
    if (!active) return;
    const idx = provider.commits.findIndex(c => c.fullHash === active.hash);
    if (idx < 0) return;
    const targetIdx = direction === 'next' ? idx + 1 : idx - 1;
    if (targetIdx < 0 || targetIdx >= provider.commits.length) return;
    const next = provider.commits[targetIdx];
    if (active.mode === 'hunk') {
        await openSelectionCommitDiff(diffProvider, next);
    } else {
        await openSelectionCommitFullDiff(provider, diffProvider, next);
    }
    void provider.revealCommit(next);
}

async function copySelectionCommitHash(commit: SelectionCommit) {
    if (!commit) return;
    await vscode.env.clipboard.writeText(commit.fullHash);
}

async function openCommitInRemote(commit: SelectionCommit) {
    if (!commit) return;
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
    }
    const cwd = folders[0].uri.fsPath;
    try {
        const { stdout } = await execAsync('git config --get remote.origin.url', { cwd });
        const webUrl = normalizeRemoteUrl(stdout.trim());
        const prMatch = commit.subject.match(PR_NUMBER_RE);
        const url = prMatch
            ? constructPrUrl(webUrl, prMatch[1])
            : constructCommitUrl(webUrl, commit.fullHash);
        await vscode.env.openExternal(vscode.Uri.parse(url));
    } catch (error) {
        vscode.window.showErrorMessage(`${error}`);
    }
}

export function activate(context: vscode.ExtensionContext) {
    const decorations = new MergeBaseDecorationProvider();
    const provider = new MergeBaseChangesProvider(decorations);
    const view = vscode.window.createTreeView('lightGit.mergeBaseChanges', {
        treeDataProvider: provider,
    });
    provider.setView(view);

    const selectionProvider = new SelectionHistoryProvider();
    const selectionView = vscode.window.createTreeView('lightGit.selectionHistory', {
        treeDataProvider: selectionProvider,
    });
    selectionProvider.setView(selectionView);

    const diffProvider = new SelectionDiffContentProvider();

    const emptyProvider: vscode.TextDocumentContentProvider = {
        provideTextDocumentContent: () => '',
    };

    const commands = [
        vscode.commands.registerCommand('lightGit.compareWithRevision', compareWithRevision),
        vscode.commands.registerCommand('lightGit.openRemote', openRemote),
        vscode.commands.registerCommand('lightGit.openRemoteMain', openRemoteMain),
        vscode.commands.registerCommand('lightGit.copyLineRangePath', copyLineRangePath),
        vscode.commands.registerCommand('lightGit.openMergeBaseDiff', openMergeBaseDiff),
        vscode.commands.registerCommand('lightGit.openChangedFile', openChangedFile),
        vscode.commands.registerCommand('lightGit.refreshMergeBaseChanges', () => provider.refresh()),
        vscode.commands.registerCommand('lightGit.showSelectionHistory', () => showSelectionHistory(selectionProvider)),
        vscode.commands.registerCommand('lightGit.refreshSelectionHistory', () => selectionProvider.refresh()),
        vscode.commands.registerCommand('lightGit.openSelectionCommitDiff', (c: SelectionCommit) => openSelectionCommitDiff(diffProvider, c)),
        vscode.commands.registerCommand('lightGit.openSelectionCommitFullDiff', (c: SelectionCommit) => openSelectionCommitFullDiff(selectionProvider, diffProvider, c)),
        vscode.commands.registerCommand('lightGit.showFullFileDiff', () => toggleSelectionDiffMode(selectionProvider, diffProvider)),
        vscode.commands.registerCommand('lightGit.showSelectionDiffOnly', () => toggleSelectionDiffMode(selectionProvider, diffProvider)),
        vscode.commands.registerCommand('lightGit.selectionDiffPrevCommit', () => navigateSelectionDiff(selectionProvider, diffProvider, 'prev')),
        vscode.commands.registerCommand('lightGit.selectionDiffNextCommit', () => navigateSelectionDiff(selectionProvider, diffProvider, 'next')),
        vscode.commands.registerCommand('lightGit.openCommitInRemote', (c: SelectionCommit) => openCommitInRemote(c)),
        vscode.commands.registerCommand('lightGit.copySelectionCommitHash', (c: SelectionCommit) => copySelectionCommitHash(c)),
    ];

    context.subscriptions.push(
        view,
        selectionView,
        vscode.window.registerFileDecorationProvider(decorations),
        vscode.workspace.registerTextDocumentContentProvider(EMPTY_SCHEME, emptyProvider),
        vscode.workspace.registerTextDocumentContentProvider(SELECTION_DIFF_SCHEME, diffProvider),
        vscode.window.tabGroups.onDidChangeTabs(updateSelectionDiffContext),
        vscode.window.tabGroups.onDidChangeTabGroups(updateSelectionDiffContext),
        ...commands
    );

    updateSelectionDiffContext();

    void provider.refresh();

    void getGitAPI().then(api => {
        if (!api) return;
        const subscribe = (repo: Repository) => {
            context.subscriptions.push(repo.state.onDidChange(() => provider.refresh()));
        };
        api.repositories.forEach(subscribe);
        context.subscriptions.push(api.onDidOpenRepository(subscribe));
    });
}

export function deactivate() {}