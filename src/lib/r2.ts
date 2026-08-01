import {
  PutObjectCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export type R2Config = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  endpoint: string;
  publicBaseUrl: string;
};

export function getR2Config(): R2Config {
  const accountId = process.env.R2_ACCOUNT_ID || "";
  const accessKeyId = process.env.R2_ACCESS_KEY_ID || "";
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || "";
  const bucket = process.env.R2_BUCKET || "";
  const endpoint =
    process.env.R2_ENDPOINT ||
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : "");
  const publicBaseUrl = (process.env.R2_PUBLIC_URL || "").replace(/\/$/, "");

  if (!accessKeyId || !secretAccessKey || !bucket || !endpoint) {
    throw new Error(
      "R2 is not configured (need R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_ENDPOINT)",
    );
  }
  if (!publicBaseUrl) {
    throw new Error("R2_PUBLIC_URL is required for public package URLs");
  }

  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucket,
    endpoint,
    publicBaseUrl,
  };
}

let client: S3Client | null = null;

export function getR2Client(): S3Client {
  if (client) return client;
  const cfg = getR2Config();
  client = new S3Client({
    region: "auto",
    endpoint: cfg.endpoint,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
  });
  return client;
}

export function publicUrlForKey(key: string): string {
  const { publicBaseUrl } = getR2Config();
  return `${publicBaseUrl}/${key.replace(/^\//, "")}`;
}

export async function uploadToR2(input: {
  key: string;
  body: Buffer | Uint8Array | string;
  contentType: string;
  cacheControl?: string;
}): Promise<{ key: string; url: string }> {
  const cfg = getR2Config();
  const s3 = getR2Client();
  await s3.send(
    new PutObjectCommand({
      Bucket: cfg.bucket,
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
      CacheControl: input.cacheControl || "public, max-age=31536000, immutable",
    }),
  );
  return { key: input.key, url: publicUrlForKey(input.key) };
}

export async function objectExists(key: string): Promise<boolean> {
  const cfg = getR2Config();
  const s3 = getR2Client();
  try {
    await s3.send(
      new HeadObjectCommand({
        Bucket: cfg.bucket,
        Key: key,
      }),
    );
    return true;
  } catch {
    return false;
  }
}
