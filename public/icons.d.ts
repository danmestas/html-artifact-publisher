export const ICON_NAMES: readonly string[];
export function validIcon(value: unknown): value is string | null | undefined;
export function iconSvg(name?: string | null, favicon?: boolean): string;
export function setArtifactFavicon(name?: string | null): void;
/** Title-only topic inference; unknown or non-string titles yield "document". */
export function inferIcon(title: unknown): string;
/** Explicit non-document icons win; "document", null, undefined and invalid values infer from the title. */
export function resolveIcon(name: unknown, title: unknown): string;
