import * as vscode from 'vscode';
import { EndAction } from './core/types';

export type EmailEvent = 'started' | 'agentFinished' | 'timerEnded' | 'guardrail' | 'warning' | 'returned';

export interface EmailSettings {
  enabled: boolean;
  to: string;
  from: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  events: EmailEvent[];
}

export interface Settings {
  lockScreen: boolean;
  turnOffDisplay: boolean;
  displayOffDelaySeconds: number;
  returnGraceSeconds: number;
  endAction: EndAction;
  maxHours: number;
  agent: {
    idleMinutes: number;
    watchTerminals: boolean;
    watchProcesses: string[];
    cpuThresholdPercent: number;
  };
  guardrails: {
    minBatteryPercent: number;
    maxTemperatureC: number;
  };
  email: EmailSettings;
}

export const SECTION = 'sleepwalker';

export function readSettings(): Settings {
  const c = vscode.workspace.getConfiguration(SECTION);
  const num = (key: string, fallback: number) => {
    const value = c.get<number>(key);
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  };
  const endAction = c.get<string>('endAction');
  return {
    lockScreen: c.get<boolean>('lockScreen', true),
    turnOffDisplay: c.get<boolean>('turnOffDisplay', true),
    displayOffDelaySeconds: num('displayOffDelaySeconds', 3),
    returnGraceSeconds: num('returnGraceSeconds', 10),
    endAction: endAction === 'hibernate' || endAction === 'none' ? endAction : 'sleep',
    maxHours: num('maxHours', 8),
    agent: {
      idleMinutes: num('agent.idleMinutes', 3),
      watchTerminals: c.get<boolean>('agent.watchTerminals', true),
      watchProcesses: c.get<string[]>('agent.watchProcesses', []).filter((s) => typeof s === 'string' && s.trim()),
      cpuThresholdPercent: num('agent.cpuThresholdPercent', 5),
    },
    guardrails: {
      minBatteryPercent: num('guardrails.minBatteryPercent', 15),
      maxTemperatureC: num('guardrails.maxTemperatureC', 90),
    },
    email: {
      enabled: c.get<boolean>('email.enabled', false),
      to: c.get<string>('email.to', '').trim(),
      from: c.get<string>('email.from', '').trim(),
      smtpHost: c.get<string>('email.smtpHost', '').trim(),
      smtpPort: num('email.smtpPort', 587),
      smtpSecure: c.get<boolean>('email.smtpSecure', false),
      smtpUser: c.get<string>('email.smtpUser', '').trim(),
      events: c.get<EmailEvent[]>('email.events', ['agentFinished', 'timerEnded', 'guardrail', 'warning']),
    },
  };
}

/** Writes a setting to the user (global) scope. */
export function writeSetting(key: string, value: unknown): Thenable<void> {
  return vscode.workspace.getConfiguration(SECTION).update(key, value, vscode.ConfigurationTarget.Global);
}
