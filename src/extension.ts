import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

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
        webUrl = webUrl.replace('git@', 'https://').replace(':', '/');
    }

    return webUrl.replace(/\.git$/, '');
}

function constructFileUrl(webUrl: string, branch: string, relativePath: string, lineNumber?: number): string {
    let fileUrl: string;

    if (webUrl.includes('github.com')) {
        fileUrl = `${webUrl}/blob/${branch}/${relativePath}`;
        if (lineNumber) fileUrl += `#L${lineNumber}`;
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

        // Get line number if in editor
        const editor = vscode.window.activeTextEditor;
        const lineNumber = editor?.document.fileName === filePath
            ? editor.selection.active.line + 1
            : undefined;

        const fileUrl = constructFileUrl(webUrl, branch, relativePath, lineNumber);
        await vscode.env.openExternal(vscode.Uri.parse(fileUrl));
    } catch (error) {
        vscode.window.showErrorMessage(`${error}`);
    }
}

export function activate(context: vscode.ExtensionContext) {
    const commands = [
        vscode.commands.registerCommand('lightGit.compareWithRevision', compareWithRevision),
        vscode.commands.registerCommand('lightGit.openRemote', openRemote)
    ];

    context.subscriptions.push(...commands);
}

export function deactivate() {}