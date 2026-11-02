/**
 * The installable application (D-230): the manifest, its pictures and the shell's links to them.
 *
 * Like the favicon, none of these can read a token — a launcher reads them outside the document — so
 * each colour is a literal bound here to the token it copies, and each picture is checked against the
 * favicon it is drawn from (`scripts/app-icons.ts`): a changed accent fails here until they are drawn again.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

interface Token {
  readonly name: string;
  readonly value: string | Readonly<Record<string, string>>;
}

interface ManifestIcon {
  readonly src: string;
  readonly sizes: string;
  readonly type: string;
  readonly purpose?: string;
}

const PUBLIC = new URL('../public/', import.meta.url);
const tokens = (
  JSON.parse(
    readFileSync(new URL('../../../packages/tokens/tokens.json', import.meta.url), 'utf8'),
  ) as { readonly color: { readonly tokens: readonly Token[] } }
).color.tokens;
const manifest = JSON.parse(readFileSync(new URL('manifest.webmanifest', PUBLIC), 'utf8')) as {
  readonly [key: string]: unknown;
  readonly icons: readonly ManifestIcon[];
};
const index = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const tokenIn = (name: string, theme: string): string => {
  const token = tokens.find((candidate) => candidate.name === name);
  if (token === undefined) throw new Error(`no colour token named ${name}`);
  return typeof token.value === 'string' ? token.value : (token.value[theme] ?? '');
};

interface Picture {
  readonly width: number;
  readonly height: number;
  /** The colour at a point, as `#rrggbb`; `transparent` where nothing was painted. */
  readonly at: (x: number, y: number) => string;
}

/** An 8-bit, non-interlaced RGB or RGBA PNG — what the generator's screenshots are. */
const decodePng = (bytes: Buffer): Picture => {
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const data: Buffer[] = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      expect(body[8]).toBe(8);
      channels = body[9] === 6 ? 4 : body[9] === 2 ? 3 : 0;
      expect(channels).toBeGreaterThan(0);
      expect(body[12]).toBe(0);
    }
    if (type === 'IDAT') data.push(body);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let row = 0; row < height; row += 1) {
    const filter = raw[row * (stride + 1)] ?? 0;
    for (let column = 0; column < stride; column += 1) {
      const value = raw[row * (stride + 1) + 1 + column] ?? 0;
      const left = column >= channels ? (pixels[row * stride + column - channels] ?? 0) : 0;
      const up = row > 0 ? (pixels[(row - 1) * stride + column] ?? 0) : 0;
      const corner =
        row > 0 && column >= channels ? (pixels[(row - 1) * stride + column - channels] ?? 0) : 0;
      const paeth = (): number => {
        const estimate = left + up - corner;
        const [a, b, c] = [left, up, corner].map((near) => Math.abs(estimate - near));
        return (a ?? 0) <= (b ?? 0) && (a ?? 0) <= (c ?? 0)
          ? left
          : (b ?? 0) <= (c ?? 0)
            ? up
            : corner;
      };
      const predicted = [0, left, up, Math.floor((left + up) / 2), paeth()][filter] ?? 0;
      pixels[row * stride + column] = (value + predicted) & 0xff;
    }
  }
  return {
    width,
    height,
    at: (x, y): string => {
      const start = y * stride + x * channels;
      if (channels === 4 && pixels[start + 3] === 0) return 'transparent';
      const hex = [0, 1, 2].map((part) =>
        (pixels[start + part] ?? 0).toString(16).padStart(2, '0'),
      );
      return `#${hex.join('')}`;
    },
  };
};

const picture = (src: string): Picture => {
  const file = new URL(src.replace(/^\//, ''), PUBLIC);
  expect(existsSync(file), `${src} is not in public/`).toBe(true);
  return decodePng(readFileSync(file));
};

describe('the manifest', () => {
  test('opens the whole application as an application of its own', () => {
    expect(manifest).toMatchObject({ start_url: '/', scope: '/', display: 'standalone' });
  });

  test("its colours are the dark theme's surface, which the shell starts in", () => {
    expect(index).toContain('data-theme="dark"');
    expect(manifest['background_color']).toBe(tokenIn('surface-100', 'dark'));
    expect(manifest['theme_color']).toBe(tokenIn('surface-100', 'dark'));
  });

  test('each icon is in public/, at the size it says', () => {
    for (const icon of manifest.icons) {
      if (icon.type === 'image/svg+xml') {
        expect(icon.src).toBe('/favicon.svg');
        continue;
      }
      const drawn = picture(icon.src);
      expect(`${String(drawn.width)}x${String(drawn.height)}`).toBe(icon.sizes);
    }
  });

  test('offers the sizes Android asks for, and one it may cut to its own shape', () => {
    const sizes = manifest.icons.map((icon) => `${icon.sizes} ${icon.purpose ?? 'any'}`);
    for (const wanted of ['192x192 any', '512x512 any', '512x512 maskable']) {
      expect(sizes).toContain(wanted);
    }
  });
});

describe('the pictures are the favicon, drawn again', () => {
  const accent = tokenIn('accent', 'dark');
  const onAccent = tokenIn('on-accent', 'dark');

  test.each(['/icon-192.png', '/icon-512.png'])('%s keeps its rounded corners', (src) => {
    const drawn = picture(src);
    expect(drawn.at(0, 0)).toBe('transparent');
    expect(drawn.at(Math.floor(drawn.width / 10), Math.floor(drawn.height / 2))).toBe(accent);
  });

  test.each(['/icon-maskable-512.png', '/apple-touch-icon.png'])(
    '%s is full-bleed: the launcher cuts its own shape',
    (src) => {
      const drawn = picture(src);
      expect(drawn.at(0, 0)).toBe(accent);
      expect(drawn.at(drawn.width - 1, drawn.height - 1)).toBe(accent);
    },
  );

  test.each(['/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/apple-touch-icon.png'])(
    "%s draws the letter in on-accent, at the favicon's place",
    (src) => {
      const drawn = picture(src);
      // The stem of the P: x 12 of the favicon's 32, a third of the way down.
      expect(drawn.at(Math.round((drawn.width * 12) / 32), Math.round(drawn.height / 3))).toBe(
        onAccent,
      );
    },
  );
});

describe('the shell', () => {
  test('links the manifest and the picture iOS puts on the home screen', () => {
    expect(index).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(index).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
    picture('/apple-touch-icon.png');
  });

  test("colours the browser's own bar like the page, in either scheme", () => {
    expect(index).toContain(
      `<meta name="theme-color" media="(prefers-color-scheme: light)" content="${tokenIn('surface-100', 'light')}" />`,
    );
    expect(index).toContain(
      `<meta name="theme-color" media="(prefers-color-scheme: dark)" content="${tokenIn('surface-100', 'dark')}" />`,
    );
  });
});
