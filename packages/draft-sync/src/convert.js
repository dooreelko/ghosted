import { createRequire } from 'node:module';
import TurndownService from 'turndown';
import { marked } from 'marked';

// @tryghost/kg-* packages' ESM builds import named exports from `lexical`,
// whose CJS entry point re-exports another module dynamically
// (`module.exports = process.env.NODE_ENV === 'development' ? require(...) : require(...)`).
// Node's cjs-module-lexer can't statically analyze that dynamic re-export, so named
// imports of `lexical` fail under ESM interop. Loading the koenig packages' CJS
// builds via `require` instead sidesteps the static analysis entirely (plain
// CJS-to-CJS `require` resolves properties dynamically at runtime).
const require = createRequire(import.meta.url);
const { LexicalHTMLRenderer } = require('@tryghost/kg-lexical-html-renderer');
const { htmlToLexical } = require('@tryghost/kg-html-to-lexical');
const { DEFAULT_NODES } = require('@tryghost/kg-default-nodes');

const renderer = new LexicalHTMLRenderer({ nodes: DEFAULT_NODES });
const turndown = new TurndownService();

export async function lexicalToMarkdown(lexicalString) {
  const html = await renderer.render(lexicalString);
  return turndown.turndown(html);
}

export function markdownToLexicalString(markdown) {
  const html = marked.parse(markdown);
  const lexicalState = htmlToLexical(html);
  return JSON.stringify(lexicalState);
}
