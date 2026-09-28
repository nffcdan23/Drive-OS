// Run: node --experimental-transform-types --no-warnings --test test/registration.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compactRegistration, displayRegistration, storedRegistration, isUkRegistration, normaliseRegistration, parseUkRegistration,
} from '../src/index.ts';

test('every UK format is recognised and spaced like the plate', () => {
  const cases: Array<[string, string, string]> = [
    ['AB12CDE', 'AB12 CDE', 'current'],
    ['A123BCD', 'A123 BCD', 'prefix'],
    ['A1BCD', 'A1 BCD', 'prefix'],
    ['ABC123D', 'ABC 123D', 'suffix'],
    ['ABC1D', 'ABC 1D', 'suffix'],
    ['A1', 'A 1', 'dateless'],
    ['1A', '1 A', 'dateless'],
    ['ABC1234', 'ABC 1234', 'dateless'], // also Northern Ireland
    ['1234AB', '1234 AB', 'dateless'],
    ['LIZ1', 'LIZ 1', 'dateless'],
  ];
  for (const [input, display, format] of cases) {
    assert.deepEqual(parseUkRegistration(input), { registration: input, display, format }, input);
  }
});

test('input is normalised: case and whitespace only', () => {
  for (const input of ['ab12 cde', ' AB12CDE ', 'AB 12 CDE', 'AB12\tCDE', 'ab12\ncde']) {
    assert.equal(parseUkRegistration(input)?.registration, 'AB12CDE', JSON.stringify(input));
  }
  assert.equal(normaliseRegistration(' b-mw 12 '), 'B-MW12');
  assert.equal(compactRegistration(' b-mw 12 '), 'B-MW12');
});

test('hyphens and dots are never stripped: a foreign plate is not a UK one', () => {
  for (const foreign of ['B-MW 1234', 'b-mw1234', 'AB12-CDE', 'AB.12.CDE', 'M-AB 123']) {
    assert.equal(parseUkRegistration(foreign), null, foreign);
  }
});

test('things that are not UK registrations are rejected (look-alikes are never swapped)', () => {
  for (const bad of ['', ' ', 'A', 'AB', '12', 'ABCDEF', '123456', 'ABCDEFGH', 'AB12CDEF', 'AB12CD', 'AB1CDE',
    'ÄB12CDE', 'AB12CD€', 'AB12_CDE', 'ABCD1234', '12345AB', 'A12345']) {
    assert.equal(parseUkRegistration(bad), null, JSON.stringify(bad));
    assert.equal(isUkRegistration(bad), false);
  }
  // "AB12 CDO" with a zero is a different, valid-looking plate; no correction happens.
  assert.equal(parseUkRegistration('AB12CD0'), null);
});

test('display: UK plates spaced, anything else compact', () => {
  assert.equal(displayRegistration('ab12cde'), 'AB12 CDE');
  assert.equal(displayRegistration('bmw 1234'), 'BMW 1234');
  assert.equal(displayRegistration('b-mw 1234'), 'B-MW1234'); // a foreign plate stays as typed
  assert.equal(displayRegistration(''), '');
});

test('stored form: whitespace removed, upper case, hyphens kept', () => {
  assert.equal(storedRegistration(' ab12 cde '), 'AB12CDE');
  assert.equal(storedRegistration('b-mw 1234'), 'B-MW1234');
});
