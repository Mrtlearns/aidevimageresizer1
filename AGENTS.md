<!-- AGENTS.md version: 1.0 - Initial import of Gemini Image Studio spec -->
# Gemini Image Studio — AGENTS.md (v1.0)
**Short project summary:** Browser-based all-in-one image utility that uses the Google Gemini API for generation, editing, analysis and batch-processing of documents (focus on receipts). The application is a single-page React + TypeScript app (React 19) that emphasizes batch document processing, OCR, memory efficiency, and developer-friendly workflows.

---

## Goals
- Provide a single UI for: Processor, Editor, Generator, Analyzer.
- Focus on batch document/receipt workflows: preprocess → enhance → OCR → export.
- Memory-efficient handling of large images (use `URL.createObjectURL` for thumbnails; lazy-load full image only for API calls).
- No build-step distribution (ES Modules & import maps supported in the runtime).

---

## Tech stack & key libs
- Frontend: React 19 + TypeScript (React DOM rendering).
- AI: Google Gemini via `@google/genai` SDK (imagen + image edit endpoints + vision analysis).
- ZIPs: `jszip` for client-side zip creation for batch downloads.
- Browser APIs: File System Access API (`showDirectoryPicker`), FileReader, URL.createObjectURL.
- Suggest state: use a lightweight store (Zustand or React Context) for global state.

---

## Project structure (recommended)
- `/src`
  - `/components` — Sidebar, ToolPanel, ImageWithHistory, FileList, Thumbnail
  - `/tools` — processor, editor, generator, analyzer handlers
  - `/lib` — api clients (Gemini wrapper), utils (image preprocess, OCR pipeline)
  - `/hooks` — useFiles, useProcessingQueue, useMCP (if used)
  - `/styles` — theme/dark-mode tokens
- `/public` — static assets
- `AGENTS.md` — this file (project guidance)
- `.env.local` — API keys (do NOT commit)

---

## Important behaviors & UX rules (Codex should follow)
- Always prefer `URL.createObjectURL` for thumbnails; only read full file when invoking API.
- Batch workflows must show per-file progress in the sidebar; global overlay only for global blocking ops.
- For Processor tool: chain Preprocess → Enhance → OCR in the Auto-Process flow. Save processed image + OCR text file.
- Preserve a visual history for each file (Original → Preprocessed → Enhanced...). Provide ability to compare any two history points.
- Editor: support prompt persistence and an optional mask/brush for inpainting.
- Analyzer: return markdown-formatted results; include a “Copy to clipboard” control.

---

## Setup commands (for bots to run)
- Install deps: `pnpm install` (or `npm install`)
- Start dev server: `pnpm dev`
- Run tests: `pnpm test`

---

## Code style & checks
- TypeScript strict mode on.
- ESLint + Prettier with project rules.
- Tests: unit tests for image utils; e2e for major workflows (optional Playwright).

---

## Safety & secrets
- **DO NOT** put API keys in this file. Point Codex to `.env` or `~/.codex/config.toml` for non-committed secrets.
- When making API calls to Gemini, implement retry/backoff and safe-content handling — surface model safety errors to the user with helpful guidance.

---

## Future requirements & TODOs (short list)
- Add brush/mask tool for Editor (inpainting).
- Render Analyzer output with Markdown parser and support table rendering.
- Add per-file granular progress indicators in UI.
- Add MCP servers/tooling if we want Codex to call external tools (image processors, ffmpeg, etc).

