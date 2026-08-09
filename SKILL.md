---
name: deep-clean-ai-skill
description: Perform a strictly read-only macOS storage audit, detect caches, rebuildable artifacts and unusually large files or directories from metadata, rank candidates by rebuildability and impact, estimate conservative versus manual-review space, build a self-contained Deep Clean AI interactive HTML donut report, and optionally start a localhost Finder Reveal bridge that only selects the exact item. Use for Mac disk-space investigations, abnormal log or offline-media discovery, cache and developer-artifact reviews, old download or app-data triage, reclaimable-space visualizations, cleanup planning, and requests to open audited items in Finder without deleting anything.
---

# Deep Clean AI Storage Audit

Create an evidence-based cleanup plan without modifying any scanned file. Treat every red item as a candidate for human review, never as permission to delete it.

## Enforce the safety contract

- Keep source inspection read-only. Never delete, move, rename, truncate, quarantine, purge, or edit a scanned path.
- Write only the audit JSON and generated report files inside an explicit output directory.
- Do not run cleanup commands, package-manager cache cleaners, `rm`, Finder trash actions, or app-specific reset tools.
- Keep selection state in browser memory only. Do not persist the plan to scanned locations.
- Expose only Finder Reveal through the bridge. Reveal the exact item with `/usr/bin/open -R`; do not expose arbitrary shell commands or paths supplied by the browser.
- If the user later asks to remove files, treat that as a separate task requiring fresh review and explicit authorization. This skill itself never removes anything.

## Run the workflow

1. Confirm the host is macOS and locate this skill directory.
2. Read [references/classification.md](references/classification.md) before interpreting results or changing classification rules.
3. Choose a new output directory in the active workspace. Avoid overwriting an earlier audit unless the user explicitly asks for regeneration.
4. Run the scanner:

   ```bash
   node scripts/scan_macos_storage.mjs --output /absolute/path/to/audit.json
   ```

   Use `--quick` for a faster first pass. It still checks Downloads, Logs, Codex and Claude tool data for large anomalies, but skips broad project, Documents, Desktop and App Container discovery. Use `--ordinary-min-mb N` to change only the ordinary cache/artifact threshold. The legacy `--min-mb` spelling is accepted as a compatibility alias. Category-specific floors remain intentional: incomplete downloads 1 MiB, downloaded installers 100 MiB, oversized logs 256 MiB, large anomaly directories 2 GiB, very large single files 5 GiB, large app data at least 350 MiB, and fonts 500 MiB.
5. Inspect the JSON before presenting it. Check `scanMeta.unreadable`, warnings, overlap notes, candidate reasons, and unusually large or ambiguous entries. Review `matchedRule`, `thresholdBytes`, `rebuildability`, `impact`, `confidence`, `estimateClass`, and `recommendedHandling`. Do not describe app data as abandoned merely because it is large.
6. Build the report into a new directory:

   ```bash
   node scripts/build_report.mjs --audit /absolute/path/to/audit.json --output /absolute/path/to/report
   ```

7. Verify the generated files and start the local bridge when Finder interaction is wanted:

   ```bash
   cd /absolute/path/to/report
   ./launch.command
   ```

   If GUI launch is unavailable, run `node finder-bridge.mjs`, then open the printed localhost URL manually. Keep the process running while the report is in use.
8. Report the possible candidate total, conservative high-confidence subtotal, manual-review subtotal, priority breakdown, important limitations, output location, and whether the bridge is running. Make clear that neither subtotal is guaranteed reclaimable space and that no scanned file was changed.

## Validate before handoff

- Ensure candidate IDs and paths are unique.
- Ensure no candidate is both an ancestor and descendant of another candidate.
- Treat APFS usage and `du` values as estimates; explain any candidate total that approaches or exceeds used space.
- Ensure the conservative subtotal contains only candidates marked `estimateClass: conservative`; never present it as permission to remove them.
- Ensure anomaly detection used metadata only. Do not open or inspect personal file contents to classify large items.
- Confirm the report works without a bridge for browsing, selection, and copying.
- Confirm Option-click or Cmd+Enter only requests Finder Reveal when served through the bridge.
- Keep protected or unreadable locations in the limitations list instead of guessing their contents.

## Use the included resources

- `scripts/scan_macos_storage.mjs`: read-only macOS scanner and JSON producer.
- `scripts/build_report.mjs`: validates audit JSON and produces the report bundle.
- `scripts/finder_bridge.mjs`: localhost-only allowlisted Finder Reveal server.
- `assets/report-template.html`: self-contained interactive report UI with no user-specific data.
- `references/classification.md`: candidate categories, priorities, exclusions, and interpretation rules.
