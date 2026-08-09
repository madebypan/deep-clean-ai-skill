# Classification and interpretation

Read this file before interpreting an audit or changing scanner rules.

## Priority model

| Priority | Meaning | Typical examples | Report color |
| --- | --- | --- | --- |
| 1 | Usually reproducible or clearly incomplete; review first | interrupted downloads, old versioned plugin copies, temporary Codex data | darkest red |
| 2 | Re-creatable cache; may cause a one-time rebuild or download | npm, Bun, Conda, app and runtime caches | dark red |
| 3 | Rebuildable developer output; confirm the project is not active | `node_modules`, `.next`, `dist`, `build`, simulator caches | medium red |
| 4 | Manual decision with meaningful context required | large downloads, oversized Git history, large app support data | light red |
| 5 | Personal or high-context data; inventory only | font libraries and other user-curated collections | palest red |

Priority is review order, not deletion authorization. The report must never label a candidate “safe to delete.”

## Decision dimensions

Keep these dimensions independent:

- `rebuildability`: `easy`, `conditional`, or `no`. Describe whether the data can be recreated, not whether it is disposable.
- `impact`: `low`, `medium`, or `high`. Estimate the likely disruption if the user later chooses to remove it.
- `confidence`: `high`, `medium`, or `low`. Express confidence in the classification from metadata and known directory semantics.
- `estimateClass`: `conservative` only when rebuildability is easy, impact is low, and classification confidence is high; otherwise use `review`.
- `recommendedHandling`: prefer an App or tool's official cleanup/download manager, then Finder review. Never emit a deletion command.

The possible total is the sum of all candidates. The conservative subtotal is only the sum of `estimateClass: conservative`; it is still an estimate and still requires human confirmation.

## Threshold model

`--ordinary-min-mb` controls only broad cache and rebuildable-artifact discovery. Keep stronger category signals separate and visible: incomplete-download extensions use 1 MiB, downloaded installers and archives use 100 MiB, large app support data uses the greater of 350 MiB or the ordinary threshold, large Git metadata uses 2 GiB, and the font-library inventory uses 500 MiB. Store the applied detector in `matchedRule` and its byte floor in `thresholdBytes` for every candidate.

## Large anomaly detection

- Read metadata only: path, name, type, byte size, and modification time. Do not read file contents.
- In quick mode, inspect Downloads, Library Logs, Codex and Claude tool directories with bounded depth and entry count.
- In full mode, additionally inspect Desktop, Documents, Application Support, Containers, and Group Containers.
- Stream directory entries instead of materializing whole trees. Stop at 30,000 entries per root in quick mode or 60,000 in full mode. Cap each anomaly-directory `du` at 10 or 20 seconds, limit them to 8 or 16 calls per root, and stop starting new calls after 30 or 60 seconds of per-root wall time. Record partial roots and exhausted budgets as limitations.
- Flag individual logs at 256 MiB, large temporary files at 256 MiB, likely offline/media/cache directories at 2 GiB, media files inside App data at 1 GiB, large installers or archives anywhere at 1 GiB, and otherwise unexplained single files at 5 GiB.
- Use allocated file bytes for candidate totals and donut proportions. Preserve logical size separately because sparse files and disk images can report a much larger logical size than the space they actually occupy.
- Classify personal or ambiguous large files as `review`, high impact, and low confidence. Capacity alone is never evidence that a file is disposable.
- Prefer a precise anomaly path over a broad App-data parent while preventing ancestor/descendant double counting.

## Standard groups

- `downloads`: incomplete or unusually large downloaded installers and archives.
- `old-plugins`: older version directories only when a newer sibling version is present.
- `package-caches`: package-manager caches and downloaded package archives.
- `runtime-caches`: developer-tool or operating-runtime caches.
- `app-caches`: non-Apple children of user cache directories.
- `dev-artifacts`: rebuildable outputs discovered under common project roots.
- `simulator`: Xcode simulator cache or device data; device data is manual-review unless clearly disposable.
- `git`: unusually large `.git` directories for repository-specific maintenance review.
- `app-data`: large Application Support or container data. Large does not mean unused or abandoned.
- `anomalies`: oversized logs, temporary files, archives, or metadata-signaled directories that need contextual review.
- `manual`: personal or ambiguous data that needs user judgment.

## Exclusions and blind spots

- Do not automatically classify documents, photos, music, mail, messages, browser profiles, passwords, cloud-drive content, backups, or virtual-machine disks as disposable.
- Do not scan package contents by default merely because an `.app` is large.
- Do not infer that app support data is an orphan from a name mismatch. Bundle identifiers and app names often differ.
- Do not bypass macOS privacy controls. Record Full Disk Access/TCC failures in `scanMeta.unreadable`.
- List local Time Machine snapshots as context only. Never delete them or count their nominal size as immediately reclaimable space.
- APFS clones, hard links, purgeable space, compression, and snapshots can make `du` totals differ from Finder and Disk Utility.

## Overlap rules

The scanner must not emit nested candidates. Prefer the more specific candidate when it carries a stronger reason; otherwise prefer the larger parent-level review unit. Split broad cache roots into children instead of adding both the root and its contents.

## Finder bridge boundary

The generated HTML sends only a candidate ID. The bridge resolves that ID against the audit data embedded in the generated page, then calls `/usr/bin/open -R` with the allowlisted path. Reject raw browser-supplied paths, non-local requests, unexpected Host or Origin headers, missing per-launch capability tokens, oversized request bodies, unsupported methods, and IDs absent from the embedded audit.
