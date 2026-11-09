import { describe, expect, it } from 'vitest';
import {
  deleteVanillaFile,
  loadVanillaStore,
  saveVanillaFile,
} from '../src/vanilla-store.js';

describe('vanilla-store without indexedDB (node)', () => {
  it('loads empty instead of throwing', async () => {
    expect(typeof indexedDB).toBe('undefined');
    await expect(loadVanillaStore()).resolves.toEqual(new Map());
  });

  it('save and delete do not throw', async () => {
    await expect(
      saveVanillaFile('x.sarc.zs', new Uint8Array([1])),
    ).resolves.toBeUndefined();
    await expect(deleteVanillaFile('x.sarc.zs')).resolves.toBeUndefined();
  });
});
