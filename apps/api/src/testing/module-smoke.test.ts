import { describe, expect, test } from 'bun:test';
import { bundledModules } from '../composition';
import {
  CORE_PATHS,
  concretePath,
  main,
  METHODS,
  problemsOf,
  probesOf,
  UNKNOWN_PATH,
  type Answer,
  type Observation,
  type Probe,
} from './module-smoke';

const NOT_FOUND: Answer = { status: 404, body: '{"error":{"code":"ROUTE_NOT_FOUND"}}' };
const ASKS_WHO: Answer = { status: 401, body: '{"error":{"code":"UNAUTHENTICATED"}}' };

const CARRIED = ['chat', 'issues'];
const probe = (module: string, path: string, method: Probe['method'] = 'GET'): Probe => ({
  module,
  method,
  path,
});

/** A process that answers each module's probes as `answerOf` says, the core up, an unknown path not found. */
const observed = (answerOf: (module: string) => Answer, core = 200): Observation => ({
  unknown: NOT_FOUND,
  answers: [probe('chat', '/api/notifications'), probe('issues', '/api/workspaces/w/issues')].map(
    (each) => ({ probe: each, answer: answerOf(each.module) }),
  ),
  core: CORE_PATHS.map((path) => ({ path, status: core })),
});

describe('the paths asked for', () => {
  test('a name becomes an id and a catch-all one segment, so a template is a path it matches', () => {
    expect(concretePath('/api/workspaces/:workspaceId/issues/**')).toBe(
      '/api/workspaces/00000000-0000-7000-8000-000000000000/issues/x',
    );
    expect(concretePath('/api/notifications')).toBe('/api/notifications');
  });

  test('every method is asked on every path every module claims, from the manifests alone', () => {
    const probes = probesOf(bundledModules);
    for (const module of bundledModules) {
      const claimed: readonly string[] = module.manifest.routes;
      const own = probes.filter((each) => each.module === module.manifest.id);
      expect(claimed.length).toBeGreaterThan(0);
      expect(own).toHaveLength(claimed.length * METHODS.length);
    }
  });

  test('the unknown path is claimed by nobody', () => {
    expect(probesOf(bundledModules).map((each) => each.path)).not.toContain(UNKNOWN_PATH);
  });
});

describe('a cell that matches its MODULES', () => {
  test('runs what it runs and closes the rest, with the core up', () => {
    const seen = observed((module) => (module === 'chat' ? ASKS_WHO : NOT_FOUND));
    expect(problemsOf(CARRIED, ['chat'], seen)).toEqual([]);
  });

  test('is the core alone when nothing runs and every module answers as an unknown path', () => {
    expect(
      problemsOf(
        CARRIED,
        [],
        observed(() => NOT_FOUND),
      ),
    ).toEqual([]);
  });

  test('is everything when every module asks who is calling', () => {
    expect(
      problemsOf(
        CARRIED,
        CARRIED,
        observed(() => ASKS_WHO),
      ),
    ).toEqual([]);
  });

  test('a module that runs may answer the not-found body to some of its requests', () => {
    const seen: Observation = {
      ...observed(() => ASKS_WHO),
      answers: [
        { probe: probe('chat', '/api/notifications'), answer: ASKS_WHO },
        { probe: probe('chat', '/api/notifications', 'DELETE'), answer: NOT_FOUND },
        { probe: probe('issues', '/api/workspaces/w/issues'), answer: ASKS_WHO },
      ],
    };
    expect(problemsOf(CARRIED, CARRIED, seen)).toEqual([]);
  });
});

describe('a cell that does not', () => {
  test('a module left out that still answers is named, with what it said', () => {
    const [problem, ...others] = problemsOf(
      CARRIED,
      ['chat'],
      observed(() => ASKS_WHO),
    );
    expect(others).toEqual([]);
    expect(problem).toContain('issues does not run');
    expect(problem).toContain('GET /api/workspaces/w/issues');
    expect(problem).toContain('401');
  });

  test('a module left out answers the same status with a different body, which is an oracle', () => {
    const different: Answer = { status: 404, body: '{"error":{"code":"MODULE_DISABLED"}}' };
    const problems = problemsOf(
      CARRIED,
      ['chat'],
      observed((module) => (module === 'chat' ? ASKS_WHO : different)),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('MODULE_DISABLED');
  });

  test('a module that should run but answers every request as an unknown path is named', () => {
    expect(
      problemsOf(
        CARRIED,
        CARRIED,
        observed((module) => (module === 'issues' ? NOT_FOUND : ASKS_WHO)),
      ),
    ).toEqual(['issues runs but every path it claims answers as a path nobody serves']);
  });

  test('a module that claims no path shows nothing, which is not a pass', () => {
    const seen: Observation = { ...observed(() => ASKS_WHO), answers: [] };
    expect(problemsOf(['chat'], ['chat'], seen)).toEqual([
      'chat claims no path, so nothing shows whether it runs',
    ]);
  });

  test('a core that is down, or an unknown path that is not a 404, is said whatever the modules do', () => {
    const down = problemsOf(
      CARRIED,
      CARRIED,
      observed(() => ASKS_WHO, 503),
    );
    expect(down).toEqual([
      "the core's /health/ready answered 503, not 200",
      "the core's /api/client answered 503, not 200",
    ]);
    const open = { ...observed(() => ASKS_WHO), unknown: ASKS_WHO };
    expect(problemsOf(CARRIED, CARRIED, open)[0]).toBe('an unknown path answered 401, not 404');
  });
});

describe('the command', () => {
  const heard = { out: [] as string[], err: [] as string[] };
  const say = {
    out: (line: string): void => void heard.out.push(line),
    err: (line: string): void => void heard.err.push(line),
  };
  const DATABASE_URL = 'postgres://u:p@localhost:5432/x';

  test('refuses to report a pass when it has no database to run a cell on', async () => {
    expect(await main({}, undefined, say)).toBe(1);
    expect(heard.err.join('\n')).toContain('DATABASE_URL is not set');
  });

  test('passes when every cell matches, one observation per cell, each said', () => {
    const cells: string[] = [];
    const matching = (cell: { ids: readonly string[]; label: string }): Promise<Observation> => {
      cells.push(cell.label);
      return Promise.resolve(
        observed((module) => (cell.ids.includes(module) ? ASKS_WHO : NOT_FOUND)),
      );
    };
    return main({ DATABASE_URL }, matching, say).then((code) => {
      expect(code).toBe(0);
      expect(cells).toEqual(['the core alone', 'chat', 'issues', 'every module (chat, issues)']);
      expect(heard.out.map((line) => line.split(':')[0])).toEqual([
        'ok   the core alone',
        'ok   chat',
        'ok   issues',
        'ok   every module (chat, issues)',
      ]);
    });
  });

  test('fails when a cell is wrong, and says which and why', async () => {
    heard.err.length = 0;
    const leaking = (): Promise<Observation> => Promise.resolve(observed(() => ASKS_WHO));
    expect(await main({ DATABASE_URL }, leaking, say)).toBe(1);
    expect(heard.err[0]).toBe('FAIL the core alone: MODULES=none');
    expect(heard.err[1]).toContain('chat does not run');
  });
});
