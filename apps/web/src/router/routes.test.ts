import { describe, expect, test } from 'bun:test';
import { MODULES } from '../modules/registry';
import { CORE_ROUTES, assertDistinctRoutes } from './routes';

describe('the route names of the core and of the modules', () => {
  test('are one set: no module names a route the core, or another module, already has', () => {
    const names = [
      ...Object.keys(CORE_ROUTES),
      ...MODULES.flatMap((module) => Object.keys(module.routes)),
    ];
    expect(new Set(names).size).toBe(names.length);
    expect(() => {
      assertDistinctRoutes([CORE_ROUTES, ...MODULES.map((module) => module.routes)]);
    }).not.toThrow();
  });

  test('are refused when a module takes the core’s name, or two modules take one', () => {
    expect(() => {
      assertDistinctRoutes([{ home: '/' }, { home: '/w/:slug/home' }]);
    }).toThrow('a route name is declared twice: home');
    expect(() => {
      assertDistinctRoutes([
        { a: '/a' },
        { b: '/w/:slug/b', c: '/w/:slug/c' },
        { b: '/x', c: '/y' },
      ]);
    }).toThrow('a route name is declared twice: b, c');
  });
});
