// Types for blobs.js, which the Worker (TypeScript) shares with the viewer and the CLI.
export interface Pointer { sha256: string; size: number; type: string }
export const BLOB_THRESHOLD: number;
export function typeOf(path: string): string;
export function isBlob(path: string, bytes: Uint8Array): boolean;
export function pointerText(p: Pointer): string;
export function parsePointer(bytes: Uint8Array | string | null | undefined): Pointer | null;
export function sha256hex(bytes: Uint8Array): Promise<string>;
export function pointerFor(path: string, bytes: Uint8Array): Promise<{ blob: Pointer; bytes: Uint8Array }>;
