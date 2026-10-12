import * as path from 'path';
import { PlatformBackend } from './backend';
import { LinuxBackend } from './linux';
import { WindowsBackend } from './windows';

/** Returns the backend for this OS, or null when the OS is not supported yet. */
export function createBackend(extensionPath: string, storageDir: string): PlatformBackend | null {
  switch (process.platform) {
    case 'win32':
      return new WindowsBackend(storageDir, path.join(extensionPath, 'helpers', 'windows', 'sleepwalker-helper.ps1'));
    case 'linux':
      return new LinuxBackend();
    default:
      return null;
  }
}
