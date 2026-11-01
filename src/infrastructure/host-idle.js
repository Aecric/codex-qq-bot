import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

// Seconds since the last keyboard, mouse or trackpad input on macOS, or null
// when the platform or the HID registry does not report it.
export async function readHostIdleSeconds({
  platform = process.platform,
  ioreg = async () => (await execute("/usr/sbin/ioreg", ["-c", "IOHIDSystem", "-d", "4"], {
    timeout: 3000,
    maxBuffer: 1024 * 1024
  })).stdout
} = {}) {
  if (platform !== "darwin") return null;
  const nanoseconds = Number(/"HIDIdleTime"\s*=\s*(\d+)/.exec(String(await ioreg()))?.[1]);
  return Number.isFinite(nanoseconds) ? nanoseconds / 1e9 : null;
}
