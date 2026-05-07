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

export function activate(context: vscode.ExtensionContext) {
    const decorations = new MergeBaseDecorationProvider();
    const provider = new MergeBaseChangesProvider(decorations);
    const view = vscode.window.createTreeView('lightGit.mergeBaseChanges', {
        treeDataProvider: provider,
    });
    provider.setView(view);

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
    ];

    context.subscriptions.push(
        view,
        vscode.window.registerFileDecorationProvider(decorations),
        vscode.workspace.registerTextDocumentContentProvider(EMPTY_SCHEME, emptyProvider),
        ...commands
    );

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