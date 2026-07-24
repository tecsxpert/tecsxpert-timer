# Tecsxpert Timer

**Track exactly how long you spend on every project — right inside VS Code. Sync sessions to your Tecsxpert GRC dashboard and log time to Jira, ClickUp, or Monday.com in one click.**

---

## Features

### ⏱ Per-Project Time Tracking
- Timer starts automatically when you open a workspace (configurable)
- Switches project context whenever you switch workspaces
- Sessions are saved locally — no data is lost if you're offline
- Only sessions longer than 30 seconds are recorded

### 📊 GRC Dashboard Sync
- Sessions sync to your [Tecsxpert GRC](https://app.tecsxpert.com) dashboard every 5 minutes
- View your today / week / month totals, 14-day activity chart, and per-project breakdown
- See your entire team's coding time on the **Team** tab

### 🔗 Link Tasks & Auto-Log Time
Connect to **Jira**, **ClickUp**, or **Monday.com** and link any issue to the current timer session. When you stop the timer, the session duration is automatically logged as a worklog — no copy-pasting.

| Integration | Auth method | Auto-logs as |
|-------------|-------------|--------------|
| Jira | API Token + email | Worklog entry |
| ClickUp | Personal API token | Time entry |
| Monday.com | API token | Item update comment |

### ⚙️ Dashboard-Controlled Settings
All timer behaviour is configured from the **Timer Settings** tab in your GRC dashboard — no need to touch VS Code settings manually:

| Setting | Description |
|---------|-------------|
| Auto-pause | Pauses timer after N minutes of inactivity (default: OFF) |
| Idle threshold | 1 – 60 minutes (shown only when auto-pause is ON) |
| Auto-start per project | Starts timer automatically when any workspace opens |
| Daily goal | Progress ring in the sidebar (default: 8 hours) |

---

## Quick Start

### 1 — Install the extension
Search **Tecsxpert Timer** in the VS Code Extensions panel, or click **Install** on this page.

### 2 — Get your API key
1. Open [app.tecsxpert.com](https://app.tecsxpert.com) and go to **Marketplace → Productivity → Dev Timer**
2. Click **Install**, then **Open Console**
3. Go to the **Setup & Keys** tab and click **Generate API Key**
4. Copy the key (it's shown only once)

### 3 — Connect VS Code to your dashboard
Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and run:

```
Tecsxpert Timer: Set API Key
```

Paste your key when prompted. The extension immediately syncs and starts tracking.

---

## Sidebar Panel

Click the **clock icon** in the Activity Bar to open the Timer sidebar. It shows:

- Current session elapsed time and project name
- Today's total coding time with a progress ring toward your daily goal
- Linked task chip (Jira issue key / ClickUp task / Monday item)
- **Start / Pause / Stop** buttons
- **Link Task** button to pick from your connected integrations

---

## Linking Tasks

1. Make sure you've connected at least one integration (see below)
2. Click **Link Task** in the sidebar (or run `Tecsxpert Timer: Link to Task` from the Command Palette)
3. Choose the integration and search for the issue/task by name or key
4. The linked task appears as a chip in the sidebar
5. Stop the timer — time is logged automatically

To remove the link without stopping: run `Tecsxpert Timer: Unlink Task`.

---

## Integration Setup

### Jira
Run `Tecsxpert Timer: Connect Jira` from the Command Palette, then enter:
- **Domain** — your Atlassian subdomain (e.g. `mycompany` for `mycompany.atlassian.net`)
- **Email** — your Atlassian account email
- **API Token** — create one at [id.atlassian.com → Security → API Tokens](https://id.atlassian.com/manage-profile/security/api-tokens)

Your token is stored in VS Code's encrypted secret storage — never in plain config.

### ClickUp
Run `Tecsxpert Timer: Connect ClickUp` and enter your **Personal API Token** from ClickUp → Profile → Apps.

### Monday.com
Run `Tecsxpert Timer: Connect Monday.com` and enter your **API Token** from Monday → Profile → Developers → My Access Tokens.

---

## Commands

| Command | Description |
|---------|-------------|
| `Tecsxpert Timer: Start Timer` | Start or resume the timer |
| `Tecsxpert Timer: Pause Timer` | Pause (toggle) |
| `Tecsxpert Timer: Stop Timer` | Stop and save the session |
| `Tecsxpert Timer: Switch Project` | Pick a different workspace or type a custom name |
| `Tecsxpert Timer: Set API Key` | Connect to your Tecsxpert GRC dashboard |
| `Tecsxpert Timer: Sync to Tecsxpert` | Force an immediate sync |
| `Tecsxpert Timer: Open Dashboard` | Open the in-editor dashboard panel |
| `Tecsxpert Timer: Link to Task` | Link a Jira / ClickUp / Monday task |
| `Tecsxpert Timer: Unlink Task` | Remove the linked task |
| `Tecsxpert Timer: Connect Jira` | Set up Jira integration |
| `Tecsxpert Timer: Connect ClickUp` | Set up ClickUp integration |
| `Tecsxpert Timer: Connect Monday.com` | Set up Monday.com integration |

---

## Configuration Reference

These settings are normally managed from the **GRC dashboard → Timer Settings** tab and pushed to VS Code automatically. You can also set them manually:

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `tecsxpert-timer.apiKey` | string | — | Your Tecsxpert API key |
| `tecsxpert-timer.apiUrl` | string | `https://api.tecsxpert.com` | API base URL |
| `tecsxpert-timer.autoStart` | boolean | `false` | Auto-start timer per project |
| `tecsxpert-timer.idleThresholdMinutes` | number | `0` | Minutes before auto-pause (0 = off) |
| `tecsxpert-timer.dailyGoalMinutes` | number | `480` | Daily coding goal in minutes |
| `tecsxpert-timer.syncIntervalMinutes` | number | `5` | How often to sync sessions |
| `tecsxpert-timer.showInStatusBar` | boolean | `true` | Show timer in status bar |

---

## Requirements

- VS Code **1.85** or later
- A [Tecsxpert GRC](https://app.tecsxpert.com) account (free) to sync sessions and use the dashboard
- Optional: Jira Cloud, ClickUp, or Monday.com account for task-linked time logging

---

## Privacy & Security

- Your Jira / ClickUp / Monday.com API tokens are stored in **VS Code's encrypted Secret Storage** — they are never written to disk in plain text and never sent to Tecsxpert servers
- Session data (project name, duration, timestamps) is synced to your Tecsxpert GRC account, which your team admin controls
- The extension makes no outbound requests other than to your configured `apiUrl` and the integration APIs you explicitly connect

---

## Support

- **Issues & feature requests:** [github.com/tecsxpert/tecsxpert-timer](https://github.com/tecsxpert/tecsxpert-timer)
- **Dashboard & account:** [app.tecsxpert.com](https://app.tecsxpert.com)
- **Email:** support@tecsxpert.com

---

*Built by [Tecsxpert Technologies Pvt Ltd](https://tecsxpert.com)*
