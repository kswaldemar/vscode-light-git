# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a VS Code extension called "Light Git" that provides lightweight git operations for file comparison and remote repository links. It's built with TypeScript and follows the VS Code extension architecture.

## Development Commands

- `npm run compile` - Compile TypeScript to JavaScript (builds to `out/` directory)
- `npm run watch` - Watch mode compilation for development
- `npm run vscode:prepublish` - Prepublish script (runs compile)

## Architecture

### Core Structure
- Single source file: `src/extension.ts` contains all extension logic
- Built with VS Code Extension API and Node.js child_process for git commands
- TypeScript compiled to CommonJS in `out/extension.js`

### Command Structure
The extension registers three main commands:
1. `lightGit.compareWithRevision` - Compare files with git revisions using diff view
2. `lightGit.openRemote` - Open files in remote repository (current branch)  
3. `lightGit.openRemoteMain` - Open files in remote repository (main branch)

### Key Components
- **Git Operations**: Uses `child_process.exec` with git CLI commands
- **Diff Provider**: Custom `TextDocumentContentProvider` for git show content
- **URL Construction**: Supports GitHub, GitLab, BitBucket with proper line number formatting
- **Context Menus**: Commands available in both Explorer and Editor contexts

### Important Implementation Details
- All git operations are async and use `execAsync` (promisified exec)
- Cursor position is preserved when opening diff views (`extension.ts:44-54`)
- Remote URL normalization handles SSH → HTTPS conversion (`extension.ts:68-76`)
- Quick pick allows both selection and custom input for revisions (`extension.ts:97-133`)
- Error handling shows user-friendly messages via VS Code notification API

## Testing & Development
- Extension loads from `out/extension.js` (compiled output)
- Requires git to be available in PATH
- Must be run in git repository with configured remote origin