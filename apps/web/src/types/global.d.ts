import type { NayaroDesktopBridge } from '@nayaro/shared';

declare global {
  interface Window {
    /** Injected by the preload script. Undefined only if preload failed to load. */
    readonly nayaro: NayaroDesktopBridge;
  }
}

export {};
