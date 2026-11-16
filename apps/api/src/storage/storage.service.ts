import { Inject, Injectable } from '@nestjs/common';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CONFIG } from '../common/tokens.js';
import type { AppConfig } from '../config.js';

/**
 * Stockage des fichiers (photos, signatures, PDF). Implémentation disque pour le développement ;
 * en production, un adaptateur S3 hébergé en UE avec URL signées de 15 min (§7.3) prendra le relais
 * derrière la même interface.
 */
@Injectable()
export class StorageService {
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  private resolve(key: string): string {
    const full = path.resolve(this.config.storageDir, key);
    if (!full.startsWith(path.resolve(this.config.storageDir) + path.sep)) throw new Error('Clé de stockage invalide');
    return full;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const file = this.resolve(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.resolve(key));
  }
}
