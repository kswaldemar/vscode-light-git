import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

const execAsync = promisify(exec);

export function activate(context: vscode.ExtensionContext) {
    const compareWithRevision = vscode.commands.registerCommand('lightGit.compareWithRevision', async (uri?: vscode.Uri) => {
        const filePath = uri?.fsPath || vscode.window.activeTextEditor?.document.fileName;
        if (!filePath) {
            vscode.window.showErrorMessage('No file selected');
            return;
        }

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri || vscode.Uri.file(filePath));
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('File is not in a workspace');
            return;
        }

        try {
            const { stdout: logOutput } = await execAsync(`git branch --format='%(refname:short)' --sort=-committerdate`, {
                cwd: workspaceFolder.uri.fsPath
            });

            const commits = logOutput.trim().split('\n').filter(line => line.trim());
            if (commits.length === 0) {
                vscode.window.showInformationMessage('No commits found for this file');
                return;
            }

            // Show quick pick for commit selection with custom input capability
            const items = commits.map(commit => {
                const [hash, ...messageParts] = commit.split(' ');
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

            const selectedItem = await new Promise<{hash: string} | undefined>((resolve) => {
                quickPick.onDidAccept(() => {
                    const selected = quickPick.selectedItems[0];
                    if (selected) {
                        // User selected an item from the list - find the original item to get the hash
                        const originalItem = items.find(item => item.label === selected.label);
                        resolve(originalItem);
                    } else if (quickPick.value) {
                        // User typed something but didn't select from list
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

            if (!selectedItem) return;

            // Get relative path from workspace root
            const relativePath = path.relative(workspaceFolder.uri.fsPath, filePath);

            // Create a simple git scheme URI for the old version
            const oldUri = vscode.Uri.from({
                scheme: 'git-show',
                path: relativePath,
                query: selectedItem.hash
            });

            // Register a text document content provider for git-show scheme
            const provider = new class implements vscode.TextDocumentContentProvider {
                async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
                    try {
                        const commitHash = uri.query;
                        const filePath = uri.path;
                        const { stdout: content } = await execAsync(`git show ${commitHash}:"${filePath}"`, {
                            cwd: workspaceFolder.uri.fsPath
                        });
                        return content;
                    } catch (error) {
                        return `Error loading content: ${error}`;
                    }
                }
            };

            const disposable = vscode.workspace.registerTextDocumentContentProvider('git-show', provider);

            try {
                // Open diff view
                await vscode.commands.executeCommand('vscode.diff', oldUri, vscode.Uri.file(filePath),
                    `${path.basename(filePath)} (${selectedItem.hash}) ↔ ${path.basename(filePath)} (Working Tree)`);
            } finally {
                // Clean up the provider after a delay
                setTimeout(() => disposable.dispose(), 10000);
            }

        } catch (error) {
            vscode.window.showErrorMessage(`Error: ${error}`);
        }
    });

    const compareWithHash = vscode.commands.registerCommand('lightGit.compareWithHash', async (uri?: vscode.Uri) => {
        const filePath = uri?.fsPath || vscode.window.activeTextEditor?.document.fileName;
        if (!filePath) {
            vscode.window.showErrorMessage('No file selected');
            return;
        }

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri || vscode.Uri.file(filePath));
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('File is not in a workspace');
            return;
        }

        try {
            // Get hash from clipboard
            const clipboardContent = await vscode.env.clipboard.readText();
            const hash = clipboardContent.trim();

            if (!hash) {
                vscode.window.showErrorMessage('Clipboard is empty');
                return;
            }

            // Get relative path from workspace root
            const relativePath = path.relative(workspaceFolder.uri.fsPath, filePath);

            // Create a simple git scheme URI for the old version
            const oldUri = vscode.Uri.from({
                scheme: 'git-show',
                path: relativePath,
                query: hash
            });

            // Register a text document content provider for git-show scheme
            const provider = new class implements vscode.TextDocumentContentProvider {
                async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
                    try {
                        const commitHash = uri.query;
                        const filePath = uri.path;
                        const { stdout: content } = await execAsync(`git show ${commitHash}:"${filePath}"`, {
                            cwd: workspaceFolder.uri.fsPath
                        });
                        return content;
                    } catch (error) {
                        return `Error loading content: ${error}`;
                    }
                }
            };

            const disposable = vscode.workspace.registerTextDocumentContentProvider('git-show', provider);

            try {
                // Open diff view
                await vscode.commands.executeCommand('vscode.diff', oldUri, vscode.Uri.file(filePath),
                    `${path.basename(filePath)} (${hash.substring(0, 7)}) ↔ ${path.basename(filePath)} (Working Tree)`);
            } finally {
                // Clean up the provider after a delay
                setTimeout(() => disposable.dispose(), 10000);
            }

        } catch (error) {
            vscode.window.showErrorMessage(`Error: ${error}`);
        }
    });

    const openRemote = vscode.commands.registerCommand('lightGit.openRemote', async (uri?: vscode.Uri) => {
        const filePath = uri?.fsPath || vscode.window.activeTextEditor?.document.fileName;
        if (!filePath) {
            vscode.window.showErrorMessage('No file selected');
            return;
        }

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri || vscode.Uri.file(filePath));
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('File is not in a workspace');
            return;
        }

        try {
            // Get remote URL
            const { stdout: remoteUrl } = await execAsync('git config --get remote.origin.url', {
                cwd: workspaceFolder.uri.fsPath
            });

            // Get current branch
            const { stdout: branch } = await execAsync('git branch --show-current', {
                cwd: workspaceFolder.uri.fsPath
            });

            // Get relative path from workspace root
            const relativePath = path.relative(workspaceFolder.uri.fsPath, filePath);

            // Clean up remote URL and construct web URL
            let webUrl = remoteUrl.trim();

            // Handle SSH URLs
            if (webUrl.startsWith('git@')) {
                webUrl = webUrl.replace('git@', 'https://').replace(':', '/');
            }

            // Remove .git suffix
            webUrl = webUrl.replace(/\.git$/, '');

            // Construct file URL based on common git hosting patterns
            let fileUrl = '';
            const currentBranch = branch.trim();

            if (webUrl.includes('github.com')) {
                fileUrl = `${webUrl}/blob/${currentBranch}/${relativePath}`;
            } else if (webUrl.includes('gitlab.com')) {
                fileUrl = `${webUrl}/-/blob/${currentBranch}/${relativePath}`;
            } else if (webUrl.includes('bitbucket.org')) {
                fileUrl = `${webUrl}/src/${currentBranch}/${relativePath}`;
            } else {
                // Generic fallback
                fileUrl = `${webUrl}/blob/${currentBranch}/${relativePath}`;
            }

            // Get current line number if in editor
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document.fileName === filePath) {
                const lineNumber = editor.selection.active.line + 1;
                if (webUrl.includes('github.com')) {
                    fileUrl += `#L${lineNumber}`;
                } else if (webUrl.includes('gitlab.com')) {
                    fileUrl += `#L${lineNumber}`;
                } else if (webUrl.includes('bitbucket.org')) {
                    fileUrl += `#lines-${lineNumber}`;
                }
            }

            // Open in browser
            await vscode.env.openExternal(vscode.Uri.parse(fileUrl));

        } catch (error) {
            vscode.window.showErrorMessage(`Error: ${error}`);
        }
    });

    context.subscriptions.push(compareWithRevision, compareWithHash, openRemote);
}

export function deactivate() {}