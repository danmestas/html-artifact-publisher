export const ICON_NAMES: readonly string[];
export function validIcon(value: unknown): value is string | null | undefined;
export function iconSvg(name?: string | null, favicon?: boolean): string;
export function setArtifactFavicon(name?: string | null): void;
