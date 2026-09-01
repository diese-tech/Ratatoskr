import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatHelpSections, HELP_SECTIONS, type HelpSection } from './help.js';

test('HELP_SECTIONS documents every entry with a non-empty usage and description', () => {
  for (const section of HELP_SECTIONS) {
    for (const entry of section.entries) {
      assert.ok(entry.usage.trim().length > 0, `usage must not be blank (section "${section.title}")`);
      assert.ok(entry.description.trim().length > 0, `description must not be blank (usage "${entry.usage}")`);
    }
  }
});

test('formatHelpSections omits sections with no entries', () => {
  const sections: HelpSection[] = [
    { title: 'Has Entries', entries: [{ usage: '/x', description: 'does x' }] },
    { title: 'Empty', entries: [] },
  ];

  const formatted = formatHelpSections(sections);
  assert.equal(formatted.length, 1);
  assert.equal(formatted[0].name, 'Has Entries');
});

test('formatHelpSections renders each entry as a usage line followed by its description', () => {
  const sections: HelpSection[] = [{ title: 'Section', entries: [{ usage: '/x arg:<y>', description: 'Does the thing.' }] }];

  const formatted = formatHelpSections(sections);
  assert.equal(formatted[0].value, '`/x arg:<y>`\nDoes the thing.');
});

test('every help section fits within Discord embed field limits', () => {
  for (const field of formatHelpSections(HELP_SECTIONS)) {
    assert.ok(field.value.length <= 1_024, `${field.name} is ${field.value.length} characters`);
  }
});

test('scout help explains the complete current workflow in plain language', () => {
  const scout = HELP_SECTIONS.find((section) => section.title.includes('Scout'));
  assert.ok(scout);
  const rendered = scout.entries.map((entry) => `${entry.usage}\n${entry.description}`).join('\n');

  for (const expected of [
    '/scout create',
    '/scout cancel',
    'eligibility role',
    'Fill',
    'same time',
    'two games',
    'Shuffle',
    'Publish',
    'Replace player',
  ]) {
    assert.ok(rendered.includes(expected), `scout help should explain ${expected}`);
  }
});
