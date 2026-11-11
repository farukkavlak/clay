import { ContainerClient, RestError, StorageSharedKeyCredential } from '@azure/storage-blob';
import { randomUUID } from 'node:crypto';

const NAMES = ['CLAY_AZURE_ENDPOINT', 'CLAY_AZURE_ACCOUNT', 'CLAY_AZURE_KEY'] as const;

/** A Blob server the environment names, with a container of its own for each test. */
export class RealAzure {
  private readonly credential: StorageSharedKeyCredential;

  private constructor(
    readonly endpoint: string,
    readonly account: string,
    readonly accountKey: string
  ) {
    this.credential = new StorageSharedKeyCredential(account, accountKey);
  }

  static fromEnv(): RealAzure {
    const missing = NAMES.filter((name) => !process.env[name]);
    if (missing.length > 0) throw new Error(`These tests need an Azure Blob server; set ${missing.join(', ')}.`);
    const [endpoint, account, accountKey] = NAMES.map((name) => process.env[name]!);
    return new RealAzure(endpoint.replace(/\/$/, ''), account, accountKey);
  }

  async newContainer(): Promise<string> {
    const container = `clay-${randomUUID()}`;
    await this.client(container).create();
    return container;
  }

  async removeContainer(container: string): Promise<void> {
    await this.client(container).delete();
  }

  async put(container: string, key: string, body: string): Promise<void> {
    await this.client(container).getBlockBlobClient(key).upload(body, Buffer.byteLength(body, 'utf8'));
  }

  async remove(container: string, key: string): Promise<void> {
    await this.client(container).getBlockBlobClient(key).delete();
  }

  /** The blob's text, or undefined where there is none. */
  async text(container: string, key: string): Promise<string | undefined> {
    try {
      const buffer = await this.client(container).getBlockBlobClient(key).downloadToBuffer();
      return buffer.toString('utf8');
    } catch (error) {
      if (error instanceof RestError && error.statusCode === 404) return undefined;
      throw error;
    }
  }

  private client(container: string): ContainerClient {
    return new ContainerClient(`${this.endpoint}/${container}`, this.credential);
  }
}
