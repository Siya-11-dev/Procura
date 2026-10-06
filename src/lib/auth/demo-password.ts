/**
 * Shared demo credential. Kept in its own module (no database imports) so a
 * client component can reference it without dragging node:sqlite into the
 * browser bundle. A real deployment must override this and source credentials
 * from the identity provider instead.
 */
export const DEMO_PASSWORD = "Procura!2026";