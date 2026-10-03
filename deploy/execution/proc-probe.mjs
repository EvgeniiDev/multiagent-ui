#!/usr/bin/env node
// deploy/execution/proc-probe.mjs — environment-identity probe, run INSIDE a
// worker container through the controller's exec gate. Prints one JSON line
// the runtime compares with the controller/docker view: proves the exec
// target is the expected container/namespace and captures pid+hostname
// identity for durable environment records.

import { readFileSync, readlinkSync, existsSync } from 'node:fs';
import os from 'node:os';
import { hostname } from 'node:os';

const read = (p) => { try { return readFileSync(p, 'utf8').trim(); } catch { return null; } };
const link = (p) => { try { return readlinkSync(p); } catch { return null; } };

const cgroup = read('/proc/self/cgroup') || '';
const containerHint =
  /docker\/([0-9a-f]{64})/.exec(cgroup)?.[1] ||
  /docker-([0-9a-f]{64})/.exec(cgroup)?.[1] ||
  null;

const readProcStat = (pid) => {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = s.lastIndexOf(')');
    const rest = s.slice(close + 2).split(' ');
    return {
      exists: true, state: rest[0] || null,
      starttime: Number(rest[19]) || null,
      syscall: readFileSync(`/proc/${pid}/syscall`, 'utf8').split(' ')[0] || null,
      ioSum: null, cpuSum: null,
    };
  } catch {
    return { exists: false };
  }
};
const targetPid = Number(process.argv[2]) || null;
const target = targetPid ? readProcStat(targetPid) : null;

const out = {
  ok: true,
  probe: 'env-controller/proc-probe@1',
  at: new Date().toISOString(),
  hostname: hostname(),
  pid: process.pid,
  ppid: process.ppid,
  targetPid,
  target,
  uid: typeof process.getuid === 'function' ? process.getuid() : null,
  gid: typeof process.getgid === 'function' ? process.getgid() : null,
  pidNs: link('/proc/self/ns/pid'),
  mntNs: link('/proc/self/ns/mnt'),
  netNs: link('/proc/self/ns/net'),
  bootId: read('/proc/sys/kernel/random/boot_id'),
  cgroupContainer: containerHint,
  // userland-visible facts the smoke asserts against
  writable: {
    tmpIsTmpfs: null,    // filled below
    home: process.env.HOME || null,
  },
  env: {
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR || null,
    HTTP_PROXY: process.env.HTTP_PROXY ? 'set' : 'unset',
    HTTPS_PROXY: process.env.HTTPS_PROXY ? 'set' : 'unset',
  },
};

// tmpfs presence check without parsing full mountinfo semantics
const mounts = read('/proc/self/mounts') || '';
out.writable.tmpIsTmpfs = /\ntmpfs\s+tmpfs\s+\/tmp\b|\btmpfs\s+\/tmp\b/.test(mounts);
out.writable.rootfsRo = /^[^ ]+ \/ (?=.*\bro\b)/m.test(mounts) ||
  /\boverlay overlay ro\b|\b\/ ext4 ro\b/.test(mounts);
out.dockerSocket = existsSync('/var/run/docker.sock');

process.stdout.write(JSON.stringify(out) + '\n');
