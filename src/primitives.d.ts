import { EventEmitter } from 'events';
import { Logger } from './index';

/** Adapt any caller-supplied logger to the canonical four-method contract. */
export function normalizeLogger(logger: unknown): Required<Logger>;

/** A logger that discards everything. */
export const noopLogger: Required<Logger>;

/** A logger that writes to the console with a `[context]` prefix. */
export const consoleLogger: Required<Logger>;

export interface SettleOnEventsSpec {
  resolveEvents?: string[];
  rejectEvents?:  Array<{ event: string; toError: (payload: unknown) => Error }>;
  timeoutMs?:     number;
  signal?:        AbortSignal;
  timeoutError?: () => Error;
  abortError?:   () => Error;
}

/** Resolve/reject on the first of a set of events, a timeout, or an abort. */
export function settleOnEvents(emitter: EventEmitter, spec: SettleOnEventsSpec): Promise<unknown>;

/** Validate-or-throw numeric option helpers (return the fallback when the value is null/undefined). */
export function nonNegInt(value             : unknown, fallback: number, name: string):                           number;
export function positiveInt(value           : unknown, fallback: number, name: string):                           number;
export function nonNegFinite(value          : unknown, fallback: number, name: string):                           number;
export function validHashAlgo(value         : unknown, fallback: string, name: string):                           string;
export function positiveFinite(value        : unknown, fallback: number, name: string):                           number;
export function atLeast(value               : unknown, fallback: number, min: number, name: string):              number;
export function positiveIntOrInfinity(value : unknown, fallback: number, name: string):                           number;
export function inRange(value               : unknown, fallback: number, min: number, max: number, name: string): number;

export interface OptionSpecEntry {
  name:  string;
  validate: (value: unknown, fallback: unknown, ...rest: unknown[]) => unknown;
  def:   unknown;
  args?: unknown[];
}
/** Validate a table of options and assign each onto `target`. */
export function applyOptions(target: object, raw: Record<string, unknown>, spec: OptionSpecEntry[]): void;