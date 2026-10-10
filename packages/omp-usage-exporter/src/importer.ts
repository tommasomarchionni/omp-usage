import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { ExporterDatabase } from './database.js';
import {
  parseEventLine,
  type FileCursor,
  type InvalidReason,
  type UsageEvent,
} from './protocol.js';

export interface ImporterOptions {
  eventsDir: string;
  /** Maximum accepted line length in bytes (newline excluded). */
  maxLineLength: number;
  /** Number of lines committed per transaction. */
  batchSize?: number;
  /** Read buffer size in bytes. */
  chunkSize?: number;
}

export interface ImportCycleResult {
  imported: number;
  duplicates: number;
  invalid: number;
  files: number;
  fileErrors: number;
  resets: number;
  durationMs: number;
}

export interface ImporterEvents {
  warning: [message: string, context?: string];
  error: [error: Error, context?: string];
  reset: [filePath: string, reason: FileResetReason];
}

export type FileResetReason = 'replaced' | 'truncated' | 'rewritten';

const TAIL_HASH_BYTES = 256;
const NEWLINE = 0x0a;
const utf8 = new TextDecoder('utf-8', { fatal: true });
// O_NOFOLLOW is not defined on Windows; 0 keeps the open() call portable.
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/**
 * Incrementally imports `*.jsonl` event files into SQLite.
 *
 * Guarantees:
 * - Only newline-terminated lines are processed; a trailing partial line is
 *   left for the next cycle.
 * - Every processed line (valid or not) advances the cursor exactly once, in
 *   the same transaction as the events it produced.
 * - Replaced (different inode/device), truncated (size < offset) and
 *   rewritten-in-place (tail hash mismatch) files are re-read from offset 0;
 *   UNIQUE(event_id) prevents double counting.
 * - Symlinks and non-regular files are ignored.
 */
export class Importer extends EventEmitter<ImporterEvents> {
  private readonly eventsDir: string;
  private readonly maxLineLength: number;
  private readonly batchSize: number;
  private readonly chunkSize: number;
  private stopping = false;
  private current: Promise<ImportCycleResult> | null = null;

  constructor(
    options: ImporterOptions,
    private readonly db: ExporterDatabase
  ) {
    super();
    this.eventsDir = options.eventsDir;
    this.maxLineLength = options.maxLineLength;
    this.batchSize = options.batchSize ?? 500;
    this.chunkSize = options.chunkSize ?? 64 * 1024;
  }

  /** True while an import cycle is running. */
  get busy(): boolean {
    return this.current !== null;
  }

  /**
   * Runs one import cycle. Concurrent calls share the in-flight cycle.
   */
  importAll(): Promise<ImportCycleResult> {
    if (this.current) return this.current;
    this.current = this.runCycle().finally(() => {
      this.current = null;
    });
    return this.current;
  }

  /**
   * Requests a stop and waits for the in-flight cycle (if any) to finish its
   * current batch. After this resolves no transaction is open.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.current) {
      await this.current.catch(() => undefined);
    }
  }

  get stopped(): boolean {
    return this.stopping;
  }

  private listEventFiles(): string[] {
    let dir: string;
    try {
      // The directory itself may be a symlink chosen by the user; entries may not.
      dir = realpathSync(this.eventsDir);
    } catch (e) {
      if (isErrno(e, 'ENOENT')) return [];
      throw e;
    }
    return readdirSync(dir)
      .filter(name => name.endsWith('.jsonl'))
      .sort()
      .map(name => join(dir, name));
  }

  private async runCycle(): Promise<ImportCycleResult> {
    const started = Date.now();
    const total: ImportCycleResult = {
      imported: 0,
      duplicates: 0,
      invalid: 0,
      files: 0,
      fileErrors: 0,
      resets: 0,
      durationMs: 0,
    };
    if (this.stopping) return total;

    const files = this.listEventFiles();
    for (const filePath of files) {
      if (this.stopping) break;
      try {
        const r = await this.importFile(filePath);
        if (r === null) continue;
        total.files++;
        total.imported += r.imported;
        total.duplicates += r.duplicates;
        total.invalid += r.invalid;
        total.resets += r.reset ? 1 : 0;
      } catch (e) {
        // One unreadable file must not stop the others.
        total.fileErrors++;
        this.emit('error', e instanceof Error ? e : new Error(String(e)), filePath);
      }
    }
    total.durationMs = Date.now() - started;
    return total;
  }

  private async importFile(
    filePath: string
  ): Promise<{ imported: number; duplicates: number; invalid: number; reset: boolean } | null> {
    // Cheap pre-check without following symlinks.
    const lst = lstatSync(filePath);
    if (!lst.isFile()) {
      if (lst.isSymbolicLink())
        this.emit('warning', 'Ignoring symlink in events directory', filePath);
      return null;
    }

    let fd: number;
    try {
      fd = openSync(filePath, constants.O_RDONLY | O_NOFOLLOW);
    } catch (e) {
      if (isErrno(e, 'ENOENT')) return null; // removed between readdir and open
      if (isErrno(e, 'ELOOP')) {
        this.emit('warning', 'Ignoring symlink in events directory', filePath);
        return null;
      }
      throw e;
    }

    try {
      const st = fstatSync(fd);
      if (!st.isFile()) return null;

      const cursor = this.db.getCursor(filePath);
      let offset = 0;
      let reset = false;
      if (cursor) {
        const why = this.checkCursor(fd, st, cursor);
        if (why) {
          reset = true;
          this.emit('reset', filePath, why);
        } else {
          offset = cursor.offset;
        }
      }

      if (offset === st.size && !reset) {
        return { imported: 0, duplicates: 0, invalid: 0, reset: false };
      }

      return { ...(await this.readFrom(fd, filePath, st, offset)), reset };
    } finally {
      closeSync(fd);
    }
  }

  private checkCursor(fd: number, st: Stats, cursor: FileCursor): FileResetReason | null {
    if (cursor.inode !== Number(st.ino) || cursor.device !== Number(st.dev)) return 'replaced';
    if (st.size < cursor.offset) return 'truncated';
    if (cursor.tailHash && cursor.offset > 0 && tailHash(fd, cursor.offset) !== cursor.tailHash) {
      return 'rewritten';
    }
    return null;
  }

  private async readFrom(
    fd: number,
    filePath: string,
    st: Stats,
    startOffset: number
  ): Promise<{ imported: number; duplicates: number; invalid: number }> {
    let imported = 0;
    let duplicates = 0;
    let invalidTotal = 0;

    const end = st.size; // never read past the size observed at open time
    const chunk = Buffer.allocUnsafe(this.chunkSize);
    let position = startOffset;

    // Current (unterminated) line state.
    let parts: Buffer[] = [];
    let partsLength = 0;
    let oversized = false;

    // Pending batch.
    let events: UsageEvent[] = [];
    let invalid: Partial<Record<InvalidReason, number>> = {};
    let linesInBatch = 0;
    let committedOffset = startOffset;
    let lineEndOffset = startOffset;

    const commit = async (): Promise<void> => {
      if (lineEndOffset === committedOffset && events.length === 0) return;
      const r = this.db.applyBatch({
        events,
        invalid,
        cursor: {
          filePath,
          offset: lineEndOffset,
          fileSize: st.size,
          inode: Number(st.ino),
          device: Number(st.dev),
          mtimeMs: Math.trunc(st.mtimeMs),
          tailHash: tailHash(fd, lineEndOffset),
        },
      });
      imported += r.imported;
      duplicates += r.duplicates;
      committedOffset = lineEndOffset;
      events = [];
      invalid = {};
      linesInBatch = 0;
      // Keep /metrics and signal handling responsive during large imports.
      await yieldToEventLoop();
    };

    const markInvalid = (reason: InvalidReason, message: string, lineStart: number): void => {
      invalid[reason] = (invalid[reason] ?? 0) + 1;
      invalidTotal++;
      this.emit('warning', `${reason} at byte ${lineStart}: ${message}`, filePath);
    };

    let lineStart = startOffset;
    while (position < end && !this.stopping) {
      const toRead = Math.min(this.chunkSize, end - position);
      const bytesRead = readSync(fd, chunk, 0, toRead, position);
      if (bytesRead === 0) break;

      let segStart = 0;
      while (segStart < bytesRead) {
        const nl = chunk.indexOf(NEWLINE, segStart);
        const segEnd = nl === -1 || nl >= bytesRead ? bytesRead : nl;
        const segLen = segEnd - segStart;

        if (!oversized) {
          if (partsLength + segLen > this.maxLineLength) {
            oversized = true;
            parts = [];
            partsLength = 0;
          } else if (segLen > 0) {
            parts.push(Buffer.from(chunk.subarray(segStart, segEnd)));
            partsLength += segLen;
          }
        }

        if (segEnd === bytesRead) break; // no newline in the rest of this chunk

        // A complete line ends at position + nl.
        lineEndOffset = position + segEnd + 1;
        if (oversized) {
          markInvalid('line_too_long', `line exceeds ${this.maxLineLength} bytes`, lineStart);
        } else {
          this.processLine(Buffer.concat(parts, partsLength), lineStart, events, markInvalid);
        }
        parts = [];
        partsLength = 0;
        oversized = false;
        lineStart = lineEndOffset;
        linesInBatch++;
        if (linesInBatch >= this.batchSize) {
          await commit();
          if (this.stopping) break;
        }
        segStart = segEnd + 1;
      }
      position += bytesRead;
    }

    await commit();
    return { imported, duplicates, invalid: invalidTotal };
  }

  private processLine(
    raw: Buffer,
    lineStart: number,
    events: UsageEvent[],
    markInvalid: (reason: InvalidReason, message: string, lineStart: number) => void
  ): void {
    let text: string;
    try {
      text = utf8.decode(raw);
    } catch {
      markInvalid('invalid_utf8', 'line is not valid UTF-8', lineStart);
      return;
    }
    if (text.endsWith('\r')) text = text.slice(0, -1);
    if (text.trim().length === 0) return; // blank lines are ignored, not invalid

    const parsed = parseEventLine(text);
    if (parsed.ok) {
      events.push(parsed.event);
    } else {
      markInvalid(parsed.reason, parsed.message, lineStart);
    }
  }
}

function tailHash(fd: number, offset: number): string {
  const len = Math.min(TAIL_HASH_BYTES, offset);
  const buf = Buffer.alloc(len);
  if (len > 0) readSync(fd, buf, 0, len, offset - len);
  return createHash('sha256').update(buf).digest('hex');
}

function isErrno(e: unknown, code: string): boolean {
  return (
    typeof e === 'object' && e !== null && 'code' in e && (e as { code: unknown }).code === code
  );
}
