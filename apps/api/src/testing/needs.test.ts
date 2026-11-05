import { describe, expect, test } from 'bun:test';
import { bundledModules } from '../composition';
import { describeNeeding, testNeeding } from './needs';
import { runComposition } from './run-composition';

describe('what a test needs of the modules a run has', () => {
  test('is a module of the build: a name that is none is refused when the test is written, not skipped for good', () => {
    expect(() => {
      testNeeding('no-such-module')('x', () => undefined);
    }).toThrow('no module of this build');
    expect(() => {
      describeNeeding('chat', 'no-such-module')('x', () => undefined);
    }).toThrow('no module of this build');
  });

  test('is met by the modules the run’s MODULES names, all of them when it is unset', () => {
    const setting = process.env['MODULES'];
    const running = runComposition.modules.map((module) => module.manifest.id);
    if (setting === undefined || setting.trim() === '') {
      expect(running).toEqual(bundledModules.map((module) => module.manifest.id));
    } else {
      expect(running.every((id) => setting.split(',').includes(id))).toBe(true);
    }
  });
});

// With every module run, the helpers register what they are given: this line runs only there, which is what it shows.
describeNeeding()('a group that needs nothing is always run', () => {
  testNeeding()('and so is a test', () => {
    expect(true).toBe(true);
  });
});
