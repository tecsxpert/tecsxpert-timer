export type IntegrationType = 'jira' | 'clickup' | 'monday';

export interface LinkedTask {
  integration: IntegrationType;
  taskId: string;
  taskKey: string;
  taskTitle: string;
  projectName: string;
  url?: string;
}

export interface GitContext {
  commitHash?: string;   // short 12-char SHA
  branch?: string;
  repoUrl?: string;
  isDirty?: boolean;     // uncommitted changes at session end
}

export interface Session {
  id: string;
  projectName: string;
  workspacePath: string;
  startTime: number;     // Unix ms (client-side clock)
  endTime: number;       // Unix ms (client-side clock)
  duration: number;      // ms
  synced: boolean;
  note?: string;
  linkedTask?: LinkedTask;
  timeLogged?: boolean;
  // GRC audit fields
  gitContext?: GitContext;
  controlIds?: string[];
  consentGiven?: boolean;
}

export interface ProjectStats {
  name: string;
  path: string;
  color: string;
  todayMs: number;
  weekMs: number;
  monthMs: number;
  totalMs: number;
  sessionCount: number;
  lastActive: number;
}

export interface DailyTotal {
  date: string;   // YYYY-MM-DD
  totalMs: number;
}

export interface StorageData {
  sessions: Session[];
  lastSync: number;
}

export interface RemoteConfigData {
  idleThresholdMinutes: number;
  dailyGoalMinutes: number;
  autoStart: boolean;
}

export interface RemoteConfig {
  success: boolean;
  data: RemoteConfigData;
}

export type TimerState = 'idle' | 'running' | 'paused';

export interface TimerStatus {
  state: TimerState;
  projectName: string;
  workspacePath: string;
  sessionStart: number;
  elapsed: number;      // ms for current session
  todayTotal: number;   // ms total for today including current
}
