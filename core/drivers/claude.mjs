import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

export function spawnThread(uuid, options = {}) {
  return new Thread(uuid, options);
}

class Thread extends EventEmitter {
  constructor(uuid, { model = 'opus', cwd = process.cwd(), env = {}, args = [], bin, resume = false } = {}) {
    super();
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(uuid)) throw new Error('Invalid session UUID');
    this.uuid = uuid;
    this.options = { model, cwd, env, args, bin };
    this.child = null;
    this.pending = new Map();
    this.stopping = false;
    this.start(resume);
  }

  start(resume) {
    const { model, cwd, env, args, bin } = this.options;
    const childEnv = { ...process.env, ...env };
    // These identify the parent harness, not this independent thread.
    for (const key of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION',
      'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_PID']) delete childEnv[key];
    this.stopping = false;
    const command = ['-p', '--model', model, '--input-format', 'stream-json',
      '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions',
      resume ? '--resume' : '--session-id', this.uuid, ...args];
    const child = spawn(bin, command, {
      cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.on('spawn', () => this.emit('spawn', { pid: child.pid, command, resume }));
    child.on('error', error => this.emit('error', error));
    child.stdin.on('error', error => this.emit('error', error));
    child.stdout.on('data', chunk => this.emit('stdout', chunk));
    child.stderr.on('data', chunk => this.emit('stderr', chunk));
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', line => {
      let event;
      try { event = JSON.parse(line); }
      catch (cause) { this.emit('error', new Error(`Invalid stream-json: ${line}`, { cause })); return; }
      this.emit('event', event);
      if (event.type === 'assistant') {
        for (const block of event.message?.content ?? []) {
          if (block.type === 'text') this.emit('text', block.text, event);
          if (block.type === 'tool_use') this.emit('tool', block, event);
        }
      }
      if (event.type === 'user') {
        for (const block of Array.isArray(event.message?.content) ? event.message.content : []) {
          if (block.type === 'tool_result') this.emit('tool', block, event);
        }
      }
      if (event.type === 'result') {
        this.emit('result', event);
        if (event.is_error) this.emit('error', Object.assign(new Error(event.result || event.errors?.join('\n') || event.subtype), { event }));
      }
      if (event.type === 'control_response') {
        const response = event.response;
        const pending = this.pending.get(response.request_id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(response.request_id);
          if (response.subtype === 'error') pending.reject(new Error(response.error));
          else pending.resolve(response);
        }
      }
    });
    this.closed = new Promise(resolve => {
      child.on('close', (code, signal) => {
        lines.close();
        this.child = null;
        const expected = this.stopping;
        this.stopping = false;
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error(`CLI closed before control response: ${code}/${signal}`));
        }
        this.pending.clear();
        resolve({ code, signal });
        this.emit('exit', { code, signal, expected });
        if (!expected) this.emit('error', new Error(`CLI exited unexpectedly: ${code}/${signal}`));
      });
    });
  }

  write(event) {
    if (!this.child || this.stopping || !this.child.stdin.writable) throw new Error('Thread is not writable');
    this.emit('input', event);
    return new Promise((resolve, reject) => {
      this.child.stdin.write(`${JSON.stringify(event)}\n`, error => error ? reject(error) : resolve());
    });
  }

  async inject(text) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('Message must be nonempty text');
    const uuid = randomUUID();
    await this.write({ type: 'user', message: { role: 'user', content: text },
      parent_tool_use_id: null, session_id: this.uuid, uuid });
    return uuid;
  }

  interrupt() {
    const request_id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request_id);
        reject(new Error('Interrupt acknowledgement timed out after 15s'));
      }, 15_000);
      this.pending.set(request_id, { resolve, reject, timer });
      this.write({ type: 'control_request', request_id,
        request: { subtype: 'interrupt' },
      }).catch(error => {
        clearTimeout(timer);
        this.pending.delete(request_id);
        reject(error);
      });
    });
  }

  async evict() {
    if (!this.child) return;
    if (this.stopping) return this.closed;
    this.stopping = true;
    this.child.kill('SIGTERM');
    let timer;
    try {
      return await Promise.race([this.closed, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('SIGTERM did not close CLI within 15s; process may still be alive')), 15_000);
      })]);
    } finally { clearTimeout(timer); }
  }

  resume() {
    if (this.child) throw new Error('Evict and await exit before resume');
    this.start(true);
    return this;
  }

  get pid() { return this.child?.pid ?? null; }
}
