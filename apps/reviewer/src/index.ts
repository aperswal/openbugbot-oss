import { Container, getContainer } from "@cloudflare/containers";

type Env = {
  AUTH_ENCRYPTION_PUBLIC_KEY: string;
  AUTH_ENCRYPTION_PRIVATE_KEY: string;
  DB: D1Database;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
  REVIEW_CONTAINER: DurableObjectNamespace<ReviewContainer>;
  REVIEW_JOBS: Queue<ReviewJob>;
};

type PullRequestEvent = {
  action: string;
  installation?: { id: number };
  number: number;
  pull_request: {
    base: { ref: string; sha: string };
    draft: boolean;
    head: { sha: string };
    user: { login: string };
  };
  repository: {
    full_name: string;
    private: boolean;
  };
};

type ReviewJob = {
  authorLogin: string;
  baseRef: string;
  baseSHA: string;
  headSHA: string;
  installationID: number;
  prNumber: number;
  repository: string;
  runID: string;
};

type ContainerResult = {
  error?: string;
  retryable?: boolean;
  success: boolean;
  updatedCodexAuth?: string;
};

const reviewActions = new Set([
  "opened",
  "reopened",
  "ready_for_review",
  "synchronize",
]);
const githubAPI = "https://api.github.com";

export class ReviewContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "20s";
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/github/webhook") {
      return handleGitHubWebhook(request, env);
    }
    if (request.method === "POST" && url.pathname === "/enroll") {
      return handleEnrollment(request, env);
    }
    return new Response("Not found", { status: 404 });
  },

  async queue(batch: MessageBatch<ReviewJob>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await runReview(message.body, env);
      } catch (error) {
        const retryable = isRetryable(error);
        if (retryable && message.attempts <= 2) {
          await updateRun(
            env,
            message.body.runID,
            "retrying",
            message.attempts,
          );
          message.retry({ delaySeconds: 30 ** message.attempts });
          continue;
        }

        await updateRun(env, message.body.runID, "failed", message.attempts);
        await commentReviewFailure(message.body, env);
        message.ack();
      }
    }
  },
} satisfies ExportedHandler<Env, ReviewJob>;

async function handleGitHubWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  const payload = await request.text();
  const signature = request.headers.get("x-hub-signature-256");
  if (
    !(await hasValidWebhookSignature(
      payload,
      signature,
      env.GITHUB_WEBHOOK_SECRET,
    ))
  ) {
    return new Response("Invalid webhook signature", { status: 401 });
  }
  if (request.headers.get("x-github-event") !== "pull_request") {
    return new Response("Ignored", { status: 202 });
  }

  let event: PullRequestEvent;
  try {
    event = JSON.parse(payload) as PullRequestEvent;
  } catch {
    return new Response("Invalid webhook payload", { status: 400 });
  }
  if (
    !reviewActions.has(event.action) ||
    event.pull_request.draft ||
    !event.installation
  ) {
    return new Response("Ignored", { status: 202 });
  }

  const job: ReviewJob = {
    authorLogin: event.pull_request.user.login.toLowerCase(),
    baseRef: event.pull_request.base.ref,
    baseSHA: event.pull_request.base.sha,
    headSHA: event.pull_request.head.sha,
    installationID: event.installation.id,
    prNumber: event.number,
    repository: event.repository.full_name,
    runID: crypto.randomUUID(),
  };

  const enrollment = await env.DB.prepare(
    "SELECT encrypted_auth FROM enrollments WHERE github_login = ?",
  )
    .bind(job.authorLogin)
    .first<{ encrypted_auth: string }>();
  if (!enrollment) {
    await commentMissingAuthOnce(job, env);
    return new Response("No enrollment", { status: 202 });
  }

  const now = new Date().toISOString();
  const inserted = await env.DB.prepare(
    `INSERT INTO review_runs (id, repository, pr_number, head_sha, author_login, installation_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)
     ON CONFLICT(repository, pr_number, head_sha) DO NOTHING`,
  )
    .bind(
      job.runID,
      job.repository,
      job.prNumber,
      job.headSHA,
      job.authorLogin,
      String(job.installationID),
      now,
      now,
    )
    .run();
  if (inserted.meta.changes > 0) {
    await env.REVIEW_JOBS.send(job);
  }
  return new Response("Queued", { status: 202 });
}

async function handleEnrollment(request: Request, env: Env): Promise<Response> {
  const githubLogin = await githubLoginFromRequest(request);
  if (!githubLogin) {
    return new Response("Unauthorized", { status: 401 });
  }
  let body: { encrypted_auth?: unknown };
  try {
    body = (await request.json()) as { encrypted_auth?: unknown };
  } catch {
    return new Response("Invalid enrollment", { status: 400 });
  }
  if (
    typeof body.encrypted_auth !== "string" ||
    body.encrypted_auth.length > 16_000
  ) {
    return new Response("Invalid enrollment", { status: 400 });
  }

  await env.DB.prepare(
    `INSERT INTO enrollments (github_login, encrypted_auth, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(github_login) DO UPDATE SET encrypted_auth = excluded.encrypted_auth, updated_at = excluded.updated_at`,
  )
    .bind(githubLogin, body.encrypted_auth, new Date().toISOString())
    .run();
  return new Response(null, { status: 204 });
}

async function runReview(job: ReviewJob, env: Env): Promise<void> {
  await updateRun(env, job.runID, "running", 0);
  const enrollment = await env.DB.prepare(
    "SELECT encrypted_auth FROM enrollments WHERE github_login = ?",
  )
    .bind(job.authorLogin)
    .first<{ encrypted_auth: string }>();
  if (!enrollment) {
    await commentMissingAuthOnce(job, env);
    await updateRun(env, job.runID, "skipped", 0);
    return;
  }

  const [codexAuth, installationToken] = await Promise.all([
    decryptAuth(enrollment.encrypted_auth, env.AUTH_ENCRYPTION_PRIVATE_KEY),
    githubInstallationToken(job.installationID, env),
  ]);
  const container = getContainer(env.REVIEW_CONTAINER, job.runID);
  const response = await container.fetch("https://review.internal/review", {
    body: JSON.stringify({ ...job, codexAuth, installationToken }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw new RetryableError(`container returned ${response.status}`);
  }
  const result = (await response.json()) as ContainerResult;
  if (!result.success) {
    const error = result.error ?? "review did not complete";
    throw result.retryable ? new RetryableError(error) : new Error(error);
  }
  if (result.updatedCodexAuth !== undefined) {
    if (
      !validCodexAuth(result.updatedCodexAuth) ||
      result.updatedCodexAuth.length > 16_000
    ) {
      throw new Error("container returned invalid refreshed Codex auth");
    }
    const refreshedAuth = await encryptAuth(
      result.updatedCodexAuth,
      env.AUTH_ENCRYPTION_PUBLIC_KEY,
    );
    await env.DB.prepare(
      "UPDATE enrollments SET encrypted_auth = ?, updated_at = ? WHERE github_login = ?",
    )
      .bind(refreshedAuth, new Date().toISOString(), job.authorLogin)
      .run();
  }
  await updateRun(env, job.runID, "complete", 0);
}

async function githubLoginFromRequest(
  request: Request,
): Promise<string | undefined> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return undefined;
  const response = await fetch(`${githubAPI}/user`, {
    headers: githubHeaders(authorization.slice("Bearer ".length)),
  });
  if (!response.ok) return undefined;
  const account = (await response.json()) as { login?: unknown };
  if (
    typeof account.login !== "string" ||
    !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(account.login)
  ) {
    return undefined;
  }
  return account.login.toLowerCase();
}

async function commentMissingAuthOnce(job: ReviewJob, env: Env): Promise<void> {
  const inserted = await env.DB.prepare(
    "INSERT INTO missing_auth_notices (repository, pr_number, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
  )
    .bind(job.repository, job.prNumber, new Date().toISOString())
    .run();
  if (inserted.meta.changes === 0) return;

  await githubRequest(
    `/repos/${job.repository}/issues/${job.prNumber}/comments`,
    job.installationID,
    env,
    {
      body: {
        body: "Couldn\u2019t review this PR. Please set up OpenBugbot with `openbugbot --login`.",
      },
      method: "POST",
    },
  );
}

async function commentReviewFailure(job: ReviewJob, env: Env): Promise<void> {
  await githubRequest(
    `/repos/${job.repository}/issues/${job.prNumber}/comments`,
    job.installationID,
    env,
    {
      body: {
        body: "OpenBugbot couldn\u2019t complete this review after retrying. Please push a new commit to retry.",
      },
      method: "POST",
    },
  );
}

async function updateRun(
  env: Env,
  runID: string,
  status: string,
  attempts: number,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE review_runs SET status = ?, attempts = ?, updated_at = ? WHERE id = ?",
  )
    .bind(status, attempts, new Date().toISOString(), runID)
    .run();
}

async function githubInstallationToken(
  installationID: number,
  env: Env,
): Promise<string> {
  const jwt = await githubAppJWT(env);
  const response = await fetch(
    `${githubAPI}/app/installations/${installationID}/access_tokens`,
    {
      headers: githubHeaders(jwt),
      method: "POST",
    },
  );
  if (!response.ok)
    throw new RetryableError(`GitHub installation token: ${response.status}`);
  return ((await response.json()) as { token: string }).token;
}

async function githubRequest(
  path: string,
  installationID: number,
  env: Env,
  init: Omit<RequestInit, "body"> & { body?: unknown },
): Promise<Response> {
  const token = await githubInstallationToken(installationID, env);
  const response = await fetch(`${githubAPI}${path}`, {
    ...init,
    body: init.body ? JSON.stringify(init.body) : undefined,
    headers: {
      ...githubHeaders(token),
      "content-type": "application/json",
      ...init.headers,
    },
  });
  if (!response.ok)
    throw new RetryableError(`GitHub request: ${response.status}`);
  return response;
}

function githubHeaders(token: string): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "openbugbot",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function githubAppJWT(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64URL(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64URL(
    JSON.stringify({
      exp: now + 9 * 60,
      iat: now - 60,
      iss: env.GITHUB_APP_ID,
    }),
  );
  const key = await importPKCS8(
    env.GITHUB_APP_PRIVATE_KEY,
    "RSASSA-PKCS1-v1_5",
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64URL(signature)}`;
}

async function decryptAuth(
  encryptedAuth: string,
  privateKeyPEM: string,
): Promise<string> {
  const envelope = JSON.parse(encryptedAuth) as {
    ciphertext: string;
    encrypted_key: string;
    nonce: string;
  };
  const privateKey = await importPKCS8(
    privateKeyPEM,
    "RSA-OAEP",
    ["decrypt"],
    "SHA-256",
  );
  const symmetricKey = await crypto.subtle.decrypt(
    { name: "RSA-OAEP" },
    privateKey,
    fromBase64(envelope.encrypted_key),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    symmetricKey,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );
  const plaintext = await crypto.subtle.decrypt(
    { iv: fromBase64(envelope.nonce), name: "AES-GCM" },
    key,
    fromBase64(envelope.ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

async function encryptAuth(
  auth: string,
  publicKeyPEM: string,
): Promise<string> {
  const publicKey = await crypto.subtle.importKey(
    "spki",
    pemData(publicKeyPEM),
    { hash: "SHA-256", name: "RSA-OAEP" },
    false,
    ["encrypt"],
  );
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { iv: nonce, name: "AES-GCM" },
    key,
    new TextEncoder().encode(auth),
  );
  const encryptedKey = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    publicKey,
    rawKey,
  );
  return JSON.stringify({
    ciphertext: toBase64(ciphertext),
    encrypted_key: toBase64(encryptedKey),
    nonce: toBase64(nonce),
  });
}

async function importPKCS8(
  pem: string,
  algorithm: "RSA-OAEP" | "RSASSA-PKCS1-v1_5",
  usages: string[],
  hash: "SHA-256" = "SHA-256",
): Promise<CryptoKey> {
  const der = pemData(pem);
  const keyData = pem.includes("BEGIN RSA PRIVATE KEY")
    ? pkcs1ToPKCS8(der)
    : der;
  return crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { hash, name: algorithm },
    false,
    usages,
  );
}

function pemData(pem: string): ArrayBuffer {
  return fromBase64(pem.replace(/-----(BEGIN|END) [^-]+-----|\s/g, ""));
}

function pkcs1ToPKCS8(pkcs1: ArrayBuffer): Uint8Array {
  const algorithmIdentifier = derSequence(
    new Uint8Array([
      0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05,
      0x00,
    ]),
  );
  return derSequence(
    concatBytes(
      new Uint8Array([0x02, 0x01, 0x00]),
      algorithmIdentifier,
      derValue(0x04, new Uint8Array(pkcs1)),
    ),
  );
}

function derSequence(content: Uint8Array): Uint8Array {
  return derValue(0x30, content);
}

function derValue(tag: number, content: Uint8Array): Uint8Array {
  const length = derLength(content.length);
  return concatBytes(new Uint8Array([tag, ...length]), content);
}

function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  for (let value = length; value > 0; value >>= 8) bytes.unshift(value & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    parts.reduce((length, part) => length + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

async function hasValidWebhookSignature(
  payload: string,
  signature: string | null,
  secret: string,
): Promise<boolean> {
  if (!signature?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(payload),
  );
  return constantTimeEqual(signature, `sha256=${toHex(signed)}`);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1)
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}

function isRetryable(error: unknown): boolean {
  return (
    error instanceof RetryableError ||
    /5\d\d|rate limit|session limit|token limit|context length/i.test(
      String(error),
    )
  );
}

class RetryableError extends Error {}

function base64URL(value: string | ArrayBuffer): string {
  const bytes =
    typeof value === "string"
      ? new TextEncoder().encode(value)
      : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function fromBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function toBase64(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function validCodexAuth(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function toHex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
