# Files in chat replies

The web panel displays preview cards for text, Markdown and PDF links directly
in agent replies, and opens them in a full preview dialog with Open. Text cards
show an excerpt, Markdown retains formatting, and PDF cards show the first page.
Cards load only near the viewport in the active chat and release file data when
scrolled away. Full previews reuse already loaded file bytes.

Markdown file formatting treats HTML as text and disables document-supplied
images and active links. The original file is preserved for downloading.

The web panel opens local file links from agent replies in a preview dialog.
Images and PDFs are rendered, Markdown retains formatting, and other text
formats (including JSON, CSV and source files) show their text. Other supported file links, such as ZIP and Office
documents, offer a download. Download always preserves the original bytes.

For agent-created deliverables, keep the files in the project directory. An
explicit output folder such as `.agent-artifacts/` makes them easy to retain.
Return ordinary Markdown links with absolute paths, or paths relative to the
session's working directory:

```markdown
![Screenshot](/home/hermes/projects/example/.agent-artifacts/screenshot.png)
[Read the report](/home/hermes/projects/example/.agent-artifacts/report.pdf)
[Text notes](.agent-artifacts/notes.txt)
[Download all files](.agent-artifacts/results.zip)
```

A linked image also opens in the viewer. ACP image/resource blocks with embedded
bytes are supported, as are local `resource_link` paths. Source line suffixes
such as `file.ts:42` are stripped before opening the file. Ordinary external web
links retain their usual behavior.

The deployed file reader serves regular files up to 32 MiB under
`/home/hermes/projects` (the state service user's `~/projects`). Files in `/tmp`,
other machines or private directories must first be copied into the project.
Hidden paths are blocked except `.agent-artifacts` and `.agent-tmp`; the state
service's persistent store is also blocked, including through symlinks. Missing,
blocked and oversized files produce a visible error. Files are read on demand,
so keep deliverables in place for old replies to remain readable.

Text previews display at most 512 KiB, with a notice when truncated; downloading
still returns the full file. PDF documents render locally in the browser using
bundled PDF.js and a worker, with Previous/Next controls, rather than relying on
Android's installed PDF viewer. Encrypted or invalid PDFs may require downloading
and opening in another application. No agent process is started for a preview.
