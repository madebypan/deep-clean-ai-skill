# Deep Clean AI Skill

A strictly read-only macOS storage audit skill for Codex. It finds space-heavy caches, rebuildable developer artifacts, old downloads, and metadata-signaled anomalies, then generates an interactive local HTML report for human review.

> A red item is a review candidate, not permission to delete it. This skill never deletes, moves, renames, truncates, or edits scanned files.

## What it does

- Scans macOS storage without modifying source files.
- Separates high-confidence candidates from items that need manual review.
- Records rebuildability, likely impact, classification confidence, matched rule, and threshold for every candidate.
- Uses allocated bytes for report totals while preserving logical size for sparse files and disk images.
- Generates a self-contained interactive donut report with grouped drill-down, selection planning, and copyable paths.
- Optionally starts a localhost Finder Reveal bridge that can only select an audited item in Finder.
- Reports protected, unreadable, partial, or time-limited scan locations instead of guessing.

## Safety model

| Component | Allowed behavior | Explicitly excluded |
| --- | --- | --- |
| Scanner | Read metadata and directory sizes; write audit JSON to the chosen output path | Deleting, moving, renaming, truncating, or cleaning files |
| HTML report | Browse candidates, select planning items in memory, and copy the list | Persistent selection state or file mutations |
| Finder bridge | Resolve an allowlisted candidate ID and run `/usr/bin/open -R` | Raw browser-supplied paths, arbitrary commands, Trash, or deletion APIs |

The bridge listens only on `127.0.0.1`, validates Host and Origin headers, requires a per-launch capability token, and rejects candidate IDs that are absent from the embedded audit.

## Requirements

- macOS
- Node.js 18 or newer
- Codex with local filesystem and shell access
- Optional: Full Disk Access for broader coverage of privacy-protected locations

The current report interface is in Traditional Chinese (`zh-Hant`).

## Install

Clone the repository into your Codex skills directory:

```bash
git clone https://github.com/madebypan/deep-clean-ai-skill.git ~/.codex/skills/deep-clean-ai-skill
```

Start a new Codex task after installation so the skill can be discovered.

## Use with Codex

Invoke the skill directly:

```text
Use $deep-clean-ai-skill to perform a full read-only storage audit on this Mac and generate the interactive report.
```

Other example requests:

```text
Use $deep-clean-ai-skill to run a quick storage scan first.
```

```text
Use $deep-clean-ai-skill to inspect caches, old downloads, developer artifacts, and unusually large files without changing anything.
```

The skill guides Codex through scanning, classification review, report generation, validation, and the optional Finder Reveal bridge.

## Run the bundled tools manually

Create the audit JSON:

```bash
node scripts/scan_macos_storage.mjs \
  --output /absolute/path/to/audit.json
```

For a faster first pass:

```bash
node scripts/scan_macos_storage.mjs \
  --quick \
  --output /absolute/path/to/audit.json
```

Build the report bundle:

```bash
node scripts/build_report.mjs \
  --audit /absolute/path/to/audit.json \
  --output /absolute/path/to/report
```

Open `index.html` for report-only browsing, or start the optional Finder Reveal bridge:

```bash
cd /absolute/path/to/report
./launch.command
```

The generated bridge exposes Finder Reveal only. It contains no deletion, move, rename, or cleanup endpoint.

## Report interactions

- Click a group to inspect its candidates.
- Click a candidate to add or remove it from the in-memory planning list.
- Option-click a candidate to reveal that exact item in Finder when the bridge is running.
- Press <kbd>Command</kbd> + <kbd>Enter</kbd> to reveal the currently hovered candidate.
- Use a trackpad pinch gesture to focus or leave a group.
- Copy the selected planning list without modifying any files.

## Classification model

Candidates are ranked from priority 1 through 5. Priority means review order, not deletion authorization.

Each item keeps four independent decision dimensions:

- `rebuildability`: easy, conditional, or not assumed rebuildable
- `impact`: low, medium, or high
- `confidence`: low, medium, or high classification confidence
- `estimateClass`: conservative or manual review

The conservative subtotal includes only easy-to-rebuild, low-impact, high-confidence candidates. It is still an estimate and still requires human confirmation.

See [references/classification.md](references/classification.md) for thresholds, groups, exclusions, overlap handling, and anomaly-scan limits.

## Important limitations

- APFS clones, compression, hard links, purgeable space, and snapshots can make totals differ from Finder or Disk Utility.
- macOS privacy controls can prevent access to some locations. The scanner records these as limitations.
- Large App Support data is not assumed abandoned or disposable merely because it is large.
- Anomaly discovery reads metadata only and uses bounded entry, depth, `du`, and wall-time budgets.
- The possible candidate total is not guaranteed reclaimable space.
- This project intentionally provides no cleanup or deletion workflow.

## Repository layout

```text
deep-clean-ai-skill/
├── SKILL.md
├── agents/openai.yaml
├── assets/report-template.html
├── references/classification.md
└── scripts/
    ├── scan_macos_storage.mjs
    ├── build_report.mjs
    └── finder_bridge.mjs
```

## License

[MIT](LICENSE)
