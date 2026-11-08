import { CreateBucketCommand, DeleteBucketCommand, DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, NoSuchKey, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';

const NAMES = ['CLAY_S3_ENDPOINT', 'CLAY_S3_ACCESS_KEY', 'CLAY_S3_SECRET_KEY'] as const;

/** An S3 server the environment names, with a bucket of its own for each test. */
export class RealS3 {
  private readonly client: S3Client;

  private constructor(
    readonly endpoint: string,
    readonly accessKey: string,
    readonly secretKey: string
  ) {
    this.client = new S3Client({ endpoint, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: accessKey, secretAccessKey: secretKey } });
  }

  static fromEnv(): RealS3 {
    const missing = NAMES.filter((name) => !process.env[name]);
    if (missing.length > 0) throw new Error(`These tests need an S3 server; set ${missing.join(', ')}.`);
    const [endpoint, accessKey, secretKey] = NAMES.map((name) => process.env[name]!);
    return new RealS3(endpoint, accessKey, secretKey);
  }

  async newBucket(): Promise<string> {
    const bucket = `clay-${randomUUID()}`;
    await this.client.send(new CreateBucketCommand({ Bucket: bucket }));
    return bucket;
  }

  async removeBucket(bucket: string): Promise<void> {
    const { Contents = [] } = await this.client.send(new ListObjectsV2Command({ Bucket: bucket }));
    for (const { Key } of Contents) await this.client.send(new DeleteObjectCommand({ Bucket: bucket, Key }));
    await this.client.send(new DeleteBucketCommand({ Bucket: bucket }));
  }

  async put(bucket: string, key: string, body: string): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
  }

  async remove(bucket: string, key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }

  /** The object's text, or undefined where there is none. */
  async text(bucket: string, key: string): Promise<string | undefined> {
    try {
      const { Body } = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return await Body!.transformToString();
    } catch (error) {
      if (error instanceof NoSuchKey) return undefined;
      throw error;
    }
  }

  close(): void {
    this.client.destroy();
  }
}
