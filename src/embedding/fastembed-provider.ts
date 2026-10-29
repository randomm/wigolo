import { mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
// Type-only: the runtime module is dynamic-imported inside getModel() so the
// native ONNX runtime is NOT mapped into the process at boot (D2 idle-footprint
// contract) — a static import loads the native binding the moment any file in
// the boot chain touches this module.
import type { FlagEmbedding } from 'fastembed';
import type { EmbedProvider } from '../providers/embed-provider.js';
import { getConfig } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('embedding');

/**
 * Ensure the fastembed model cache dir (and any missing parents) exists, then
 * return it. fastembed's own `retrieveModel` does a NON-recursive
 * `mkdirSync(cacheDir)`, so on a fresh machine where `${dataDir}` (e.g.
 * `~/.wigolo`) does not exist yet the download throws
 * `ENOENT: mkdir '...\.wigolo\fastembed'` (seen on Windows). Pre-creating the
 * dir recursively makes fastembed's own `existsSync` check pass and skips its
 * broken mkdir.
 */
export function ensureFastembedCacheDir(dataDir: string): string {
  const cacheDir = join(dataDir, 'fastembed');
  mkdirSync(cacheDir, { recursive: true });
  return cacheDir;
}

/**
 * Remove the fastembed cache dir and recreate it empty — used to clear a
 * partial/corrupt model download (a leftover `.tar.gz` that fastembed will not
 * re-fetch) before retrying.
 */
export function resetFastembedCacheDir(dataDir: string): string {
  rmSync(join(dataDir, 'fastembed'), { recursive: true, force: true });
  return ensureFastembedCacheDir(dataDir);
}

/**
 * True when an error looks like a truncated/corrupt model archive — the field
 * `TAR_BAD_ARCHIVE: Unrecognized archive format` and its decompress cousins.
 * These recover by wiping the partial file and re-downloading; unrelated errors
 * (e.g. a missing native tokenizer binary) do NOT, so they must not match.
 */
export function isCorruptArchiveError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /TAR_BAD_ARCHIVE|Unrecognized archive format|unexpected end of (file|data)|incorrect header check|invalid (tar|gzip)|zlib/i.test(
    msg,
  );
}

/**
 * Run a model init; on a corrupt-archive failure ONLY, reset the cache and try
 * exactly once more. Any other error propagates immediately (a re-download would
 * not fix it). Pure over its injected `init`/`resetCache`, so the retry is tested
 * without touching the network or the native runtime.
 */
export async function initModelWithArchiveRetry<T>(
  init: () => Promise<T>,
  resetCache: () => void,
): Promise<T> {
  try {
    return await init();
  } catch (err) {
    if (!isCorruptArchiveError(err)) throw err;
    resetCache();
    return await init();
  }
}

/**
 * Texts per ONNX run. Activation memory grows with batch x seqLen^2 and the ORT
 * CPU arena keeps its peak for the life of the session, so one run over every
 * input (find_similar, context-rank) ratchets RSS up for good.
 */
export const FASTEMBED_MAX_BATCH = 8;

type SessionFactory = { create: (...args: unknown[]) => Promise<unknown> };
const THREADS_APPLIED = Symbol.for('wigolo.ortIntraOpThreads');

/**
 * Make every ORT session created through `session.create` use `threads` intra-op
 * threads. ORT sizes its pool from the host CPU count, not a container's CPU
 * quota: on a 32-thread host under `--cpus=4`, embedding ran ~10x slower from
 * CFS throttling. fastembed's `init()` takes no session options, so the factory
 * is wrapped instead. Applied once per process; returns whether it wrapped.
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

/** Apply `limitOrtIntraOpThreads` to the onnxruntime-node instance fastembed itself loads. */
async function applyEmbeddingThreads(threads: number): Promise<void> {
  if (!(threads > 0)) return;
  const req = createRequire(import.meta.resolve('fastembed'));
  const ort = await import(pathToFileURL(req.resolve('onnxruntime-node')).href);
  const session = (ort.InferenceSession ?? ort.default?.InferenceSession) as SessionFactory | undefined;
  if (session && limitOrtIntraOpThreads(session, threads)) {
    log.info('ORT intra-op threads limited', { threads });
  }
}

/**
 * Native ONNX embedding provider using fastembed-rs Node bindings.
 *
 * Model: BGE-small-en-v1.5 (384-dim). First call to `warmup()` downloads
 * the ONNX model to `${dataDir}/fastembed`. Subsequent runs reuse the cache.
 * Replaces the legacy sentence-transformers Python subprocess.
 */
export class FastembedEmbedProvider implements EmbedProvider {
  private model: FlagEmbedding | null = null;
  private modelPromise: Promise<FlagEmbedding> | null = null;
  readonly modelId: string;
  readonly dim: number;

  constructor() {
    this.modelId = 'BGE-small-en-v1.5';
    this.dim = 384;
  }

  async warmup(): Promise<void> {
    await this.getModel();
  }

  private getModel(): Promise<FlagEmbedding> {
    if (this.model) return Promise.resolve(this.model);
    if (this.modelPromise) return this.modelPromise;
    log.info('Loading embedding model', { modelId: this.modelId });
    const dataDir = getConfig().dataDir;
    const cacheDir = ensureFastembedCacheDir(dataDir);
    this.modelPromise = applyEmbeddingThreads(getConfig().embeddingThreads)
      .then(() => import('fastembed'))
      .then(({ FlagEmbedding, EmbeddingModel }) =>
        initModelWithArchiveRetry(
          () => FlagEmbedding.init({ model: EmbeddingModel.BGESmallENV15, cacheDir }),
          () => resetFastembedCacheDir(dataDir),
        ),
      )
      .then(m => {
      this.model = m;
      log.info('Embedding model ready', { modelId: this.modelId, dim: this.dim });
      return m;
    }).catch(err => {
      this.modelPromise = null;
      throw err;
    });
    return this.modelPromise;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const model = await this.getModel();
    const out: Float32Array[] = [];
    for await (const batch of model.embed(texts, FASTEMBED_MAX_BATCH)) {
      for (const vec of batch) {
        out.push(Float32Array.from(vec));
      }
    }
    return out;
  }
}
