# Light Git

Lightweight VS Code extension for essential git operations without the bloat.

## Features

- **Compare with Revision**: Right-click any file → "Compare with Revision" → select from recent commits → opens diff view
- **Open in Remote**: Right-click any file → "Open in Remote" → opens browser with GitHub/GitLab/Bitbucket link (includes line numbers)
- **Copy Line Range + Path**: Select code in editor → run command palette "Copy Line Range + Path" → copies `-Lstart,end:relative/path` to clipboard

## Usage

### Compare Files with Previous Revisions
1. Right-click on any file in Explorer or Editor
2. Select "Compare with Revision"
3. Choose a commit from the quick pick menu
4. Diff view opens showing changes

### Open File in Remote Repository
1. Right-click on any file in Explorer or Editor
2. Select "Open in Remote"
3. Browser opens to the file on GitHub/GitLab/Bitbucket
4. If cursor is positioned in editor, line number is included in URL

### Copy Line Range + Path (for git -L or tooling)
1. Select any text (or place cursor on a line) in the editor
2. Run command: `Light Git: Copy Line Range + Path` from the Command Palette
3. Clipboard receives: `-L<N>,<M>:relative/path/to/file`
	- If no selection: `N == M` (single line)
	- If selection ends at column 0 of next line, end line auto-adjusts to previous line
4. Paste into git commands like: `git log -L <copied-fragment>`

## Supported Git Hosts

- GitHub
- GitLab
- Bitbucket
- Generic git hosts (fallback)

## Requirements

- Git must be installed and available in PATH
- Files must be in a git repository
- Remote origin must be configured

## Why Light Git?

Built as a lightweight alternative to feature-heavy git extensions. Focuses on the two most essential operations:
- Quick file comparisons with history
- Easy access to remote repository files

No telemetry, no heavy dependencies, just fast git operations.

## License

MIT
