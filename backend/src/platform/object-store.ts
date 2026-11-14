// backend/src/platform/object-store.ts
// Content-addressed object storage for evidence bytes.
// memory mode: process-local Map (local and test). s3 mode: any S3-compatible endpoint (MinIO, AWS S3)
// using AWS Signature V4 over Node's built-in fetch, so no SDK dependency is required.

import crypto from "node:crypto";
import { AppConfig, loadConfig } from "./config";
import { AppError } from "./errors";

export interface ObjectStore {
  readonly mode: "memory" | "s3";
  put(key: string, body: string): Promise<void>;
  get(key: string): Promise<string | null>;
  health(): Promise<{ ok: boolean; detail: string }>;
}

/** Process-local backing map for memory mode. */
export const memoryObjectStore = new Map<string, string>();

class MemoryObjectStore implements ObjectStore {
  readonly mode = "memory" as const;

  async put(key: string, body: string): Promise<void> {
    memoryObjectStore.set(key, body);
  }

  async get(key: string): Promise<string | null> {
    return memoryObjectStore.get(key) ?? null;
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: "memory object store" };
  }
}

// ---------------------------------------------------------------------------
// AWS Signature Version 4
// ---------------------------------------------------------------------------

export interface SigV4Input {
  method: string;
  canonicalPath: string;
  canonicalQuery: string;
  /** Lowercase header names; every header supplied here is signed. */
  headers: Record<string, string>;
  payloadHash: string;
  accessKey: string;
  secretKey: string;
  region: string;
  service: string;
  /** Basic ISO 8601 timestamp, for example 20150830T123600Z */
  amzDate: string;
}

function hmac(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Of(data: string | Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function signV4(input: SigV4Input): string {
  const date = input.amzDate.slice(0, 8);
  const names = Object.keys(input.headers).map((n) => n.toLowerCase()).sort();
  const canonicalHeaders = names
    .map((n) => `${n}:${String(input.headers[n]).trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const signedHeaders = names.join(";");

  const canonicalRequest = [
    input.method.toUpperCase(),
    input.canonicalPath,
    input.canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    input.payloadHash
  ].join("\n");

  const scope = `${date}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", input.amzDate, scope, sha256Of(canonicalRequest)].join("\n");

  const kDate = hmac(`AWS4${input.secretKey}`, date);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");

  return `AWS4-HMAC-SHA256 Credential=${input.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

function toAmzDate(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

// ---------------------------------------------------------------------------
// S3-compatible store (path-style addressing, which MinIO requires)
// ---------------------------------------------------------------------------

export type S3Settings = Pick<
  AppConfig,
  "objectStoreEndpoint" | "objectStoreBucket" | "objectStoreRegion" | "objectStoreAccessKey" | "objectStoreSecretKey"
>;

const REQUEST_TIMEOUT_MS = 10000;

export class S3ObjectStore implements ObjectStore {
  readonly mode = "s3" as const;
  private bucketReady: Promise<void> | null = null;
  private readonly host: string;
  private readonly basePath: string;
  private readonly origin: string;

  constructor(
    private readonly settings: S3Settings,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly clock: () => Date = () => new Date()
  ) {
    const url = new URL(settings.objectStoreEndpoint);
    this.host = url.host;
    this.origin = `${url.protocol}//${url.host}`;
    this.basePath = url.pathname.replace(/\/+$/, "");
  }

  private pathFor(key: string | null): string {
    const bucket = encodeRfc3986(this.settings.objectStoreBucket);
    if (key === null) {
      return `${this.basePath}/${bucket}`;
    }
    const encodedKey = key.split("/").map(encodeRfc3986).join("/");
    return `${this.basePath}/${bucket}/${encodedKey}`;
  }

  private async request(method: string, key: string | null, body?: string): Promise<Response> {
    const path = this.pathFor(key);
    const payload = body ?? "";
    const payloadHash = sha256Of(Buffer.from(payload, "utf8"));
    const amzDate = toAmzDate(this.clock());

    const headers: Record<string, string> = {
      host: this.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate
    };
    const authorization = signV4({
      method,
      canonicalPath: path,
      canonicalQuery: "",
      headers,
      payloadHash,
      accessKey: this.settings.objectStoreAccessKey,
      secretKey: this.settings.objectStoreSecretKey,
      region: this.settings.objectStoreRegion,
      service: "s3",
      amzDate
    });

    try {
      return await this.fetchImpl(`${this.origin}${path}`, {
        method,
        headers: {
          "x-amz-content-sha256": payloadHash,
          "x-amz-date": amzDate,
          authorization
        },
        body: body === undefined ? undefined : body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch {
      // Never echo transport errors: they can carry endpoint details
      throw new AppError("UNAVAILABLE", "Object store is unreachable.");
    }
  }

  private ensureBucket(): Promise<void> {
    if (!this.bucketReady) {
      this.bucketReady = (async () => {
        const head = await this.request("HEAD", null);
        if (head.ok) return;
        if (head.status !== 404) {
          throw new AppError("UNAVAILABLE", `Object store bucket check failed (${head.status}).`);
        }
        const created = await this.request("PUT", null, "");
        // 409 means another instance created it first, which is fine
        if (!created.ok && created.status !== 409) {
          throw new AppError("UNAVAILABLE", `Object store bucket creation failed (${created.status}).`);
        }
      })().catch((err) => {
        this.bucketReady = null;
        throw err;
      });
    }
    return this.bucketReady;
  }

  async put(key: string, body: string): Promise<void> {
    await this.ensureBucket();
    const res = await this.request("PUT", key, body);
    if (!res.ok) {
      throw new AppError("UNAVAILABLE", `Object store write failed (${res.status}).`);
    }
  }

  async get(key: string): Promise<string | null> {
    await this.ensureBucket();
    const res = await this.request("GET", key);
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new AppError("UNAVAILABLE", `Object store read failed (${res.status}).`);
    }
    return res.text();
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.ensureBucket();
      return { ok: true, detail: `s3 bucket ${this.settings.objectStoreBucket} reachable` };
    } catch (err: any) {
      return { ok: false, detail: err?.message || "object store unavailable" };
    }
  }
}

// ---------------------------------------------------------------------------
// Selection and integrity helpers
// ---------------------------------------------------------------------------

let override: ObjectStore | null = null;
let cachedS3: { signature: string; store: ObjectStore } | null = null;
const memoryStore = new MemoryObjectStore();

/** Test hook: force a specific store (pass null to restore selection by config). */
export function setObjectStoreForTests(store: ObjectStore | null): void {
  override = store;
}

export function getObjectStore(cfg: AppConfig = loadConfig()): ObjectStore {
  if (override) return override;
  if (cfg.objectStoreMode !== "s3") return memoryStore;

  const signature = [cfg.objectStoreEndpoint, cfg.objectStoreBucket, cfg.objectStoreRegion, cfg.objectStoreAccessKey].join("|");
  if (!cachedS3 || cachedS3.signature !== signature) {
    cachedS3 = { signature, store: new S3ObjectStore(cfg) };
  }
  return cachedS3.store;
}

/**
 * Writes content-addressed bytes and, for durable stores, reads them straight back to prove
 * the stored bytes hash to the expected digest before the caller records the key.
 */
export async function putVerified(store: ObjectStore, key: string, bytes: string, expectedSha256: string): Promise<void> {
  await store.put(key, bytes);
  if (store.mode === "memory") return;
  await readVerified(store, key, expectedSha256);
}

/** Reads an object and refuses it unless it hashes to the digest recorded in the manifest. */
export async function readVerified(store: ObjectStore, key: string, expectedSha256: string): Promise<string> {
  const bytes = await store.get(key);
  if (bytes === null) {
    throw new AppError("CONFLICT", "Stored evidence object is missing.");
  }
  if (sha256Of(Buffer.from(bytes, "utf8")) !== expectedSha256) {
    throw new AppError("CONFLICT", "Stored evidence object failed integrity verification.");
  }
  return bytes;
}
