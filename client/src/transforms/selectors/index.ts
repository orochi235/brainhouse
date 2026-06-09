/**
 * Selector engine entry-point. Today this re-exports the mock from
 * `./mock.ts`. When Spec 1 (selector engine + migration) lands, swap the
 * three re-exports below to point at the real implementation. The inspector
 * and any downstream consumer see identical types either way.
 */

export type { Selector, SelectorDef, SelectorNode } from './types.ts';
export { MOCK_SELECTORS as SELECTORS, resolveSelector, compileSelector } from './mock.ts';
