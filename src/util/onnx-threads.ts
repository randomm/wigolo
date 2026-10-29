import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createLogger } from '../logger.js';

const log = createLogger('providers');

type SessionFactory = { create: (...args: unknown[]) => Promise<unknown> };
const THREADS_APPLIED = Symbol.for('wigolo.ortIntraOpThreads');

/**
 * Make every ORT session created through `session.create` use `threads` intra-op
 * threads. ORT sizes its pool from the host CPU count, not a container's CPU
 * quota: on a 32-thread host under `--cpus=4`, embedding and reranking ran ~9-10x
 * slower from CFS throttling. Neither fastembed nor Transformers.js exposes session
 * options here, so the factory is wrapped instead. Applied once per factory;
 * returns whether it wrapped.
 */
export function limitOrtIntraOpThreads(session: SessionFactory, threads: number): boolean {
  const tagged = session as SessionFactory & { [THREADS_APPLIED]?: number };
  if (!(threads > 0) || tagged[THREADS_APPLIED] !== undefined) return false;
  const create = session.create.bind(session);
  session.create = (...args: unknown[]) => {
    const last = args[args.length - 1];
    const hasOpts = args.length > 1 && typeof last === 'object' && last !== null && !ArrayBuffer.isView(last);
    const head = hasOpts ? args.slice(0, -1) : args;
    return create(...head, { ...(hasOpts ? last : {}), intraOpNumThreads: threads });
  };
  tagged[THREADS_APPLIED] = threads;
  return true;
}

/** Packages that create ORT sessions; each resolves its own onnxruntime-node. */
const ORT_USERS = ['fastembed', '@huggingface/transformers'];

/**
 * Apply `limitOrtIntraOpThreads` to the onnxruntime-node instance(s) the ONNX
 * users load. Call before a provider creates its first session. No-op for 0.
 */
export async function applyOnnxThreads(threads: number): Promise<void> {
  if (!(threads > 0)) return;
  const paths = new Set<string>();
  for (const pkg of ORT_USERS) {
    try {
      paths.add(createRequire(import.meta.resolve(pkg)).resolve('onnxruntime-node'));
    } catch {
      // Optional dependency not installed: nothing of it to limit.
    }
  }
  for (const path of paths) {
    const ort = await import(pathToFileURL(path).href);
    const session = (ort.InferenceSession ?? ort.default?.InferenceSession) as SessionFactory | undefined;
    if (session && limitOrtIntraOpThreads(session, threads)) {
      log.info('ORT intra-op threads limited', { threads, path });
    }
  }
}
