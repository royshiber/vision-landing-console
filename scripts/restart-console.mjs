import { execSync, spawn } from 'child_process';
import process from 'process';

// Why: avoid PowerShell execution-policy issues on Windows.
// What: kills whatever listens on PORT (default 4010) and then starts `node server.js`.

const repoRoot = new URL('..', import.meta.url).pathname;
process.chdir(repoRoot);

const port = Number(process.env.PORT || 4010);

function killListenerOnPort(p) {
  try {
    const out = execSync(`netstat -ano -p tcp | findstr :${p} | findstr LISTENING`, { encoding: 'utf8' });
    const firstLine = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (!firstLine) return;
    const parts = firstLine.split(/\s+/);
    const pid = parts[parts.length - 1];
    if (!pid) return;
    execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
  } catch {
    // ignore: no listener or tools unavailable
  }
}

killListenerOnPort(port);

// Start server in the foreground so `npm run start:clean` keeps running.
const child = spawn(process.execPath, ['server.js'], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));

