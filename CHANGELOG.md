# Changelog

## [1.1.0] — 2026-07-24

### Added
- **Timer Settings via GRC Dashboard** — auto-pause, idle threshold, auto-start, and daily goal are now configurable from the Tecsxpert GRC dashboard (Timer Settings tab) and pushed to VS Code automatically on next sync
- **Auto-start per project** — when enabled from the dashboard, the timer starts automatically whenever a workspace opens, tracking each project independently
- Remote config now applies `autoStart` from the dashboard (previously only idle threshold and daily goal were synced)

### Changed
- **Auto-pause is OFF by default** — timer runs continuously until manually stopped; users opt in to auto-pause from the dashboard
- **Auto-start is OFF by default** — timer no longer starts on workspace open unless explicitly enabled
- Extension waits for remote config before deciding whether to auto-start, so dashboard settings take effect immediately on next VS Code launch

### Fixed
- Auto-start now correctly reads the dashboard setting rather than always defaulting to `true`
- Idle threshold default corrected from 5 minutes to 0 (disabled) to match dashboard default

---

## [1.0.0] — 2026-07-23

### Added
- Per-project time tracking with sidebar panel in the VS Code Activity Bar
- Session sync to Tecsxpert GRC dashboard (every 5 minutes + immediately after each session)
- Status bar timer display with elapsed time and project name
- **Jira integration** — link issues, auto-log worklog on stop
- **ClickUp integration** — link tasks, auto-log time entry on stop
- **Monday.com integration** — link items, log time as update comment on stop
- In-editor dashboard panel with today/week/month stats, 14-day chart, and project breakdown
- Idle auto-detection with configurable threshold
- Offline-first: sessions stored locally and synced when connection is available
- API key management via VS Code Secret Storage
