import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lexicalToMarkdown, markdownToLexicalString } from '../src/convert.js';

const SIMPLE_LEXICAL = JSON.stringify({
  root: {
    children: [
      {
        children: [{ detail: 0, format: 0, mode: 'normal', style: '', text: 'Hello world', type: 'text', version: 1 }],
        direction: 'ltr', format: '', indent: 0, type: 'paragraph', version: 1
      }
    ],
    direction: 'ltr', format: '', indent: 0, type: 'root', version: 1
  }
});

test('lexicalToMarkdown renders a simple paragraph', async () => {
  const markdown = await lexicalToMarkdown(SIMPLE_LEXICAL);
  assert.match(markdown, /Hello world/);
});

test('markdownToLexicalString produces a parseable lexical doc containing the text', () => {
  const lexicalString = markdownToLexicalString('Hello world');
  const parsed = JSON.parse(lexicalString);
  assert.equal(parsed.root.type, 'root');
  assert.match(JSON.stringify(parsed), /Hello world/);
});

test('round trip: lexical -> markdown -> lexical -> markdown keeps the text', async () => {
  const markdown1 = await lexicalToMarkdown(SIMPLE_LEXICAL);
  const lexical2 = markdownToLexicalString(markdown1);
  const markdown2 = await lexicalToMarkdown(lexical2);
  assert.match(markdown2, /Hello world/);
});
