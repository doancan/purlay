// Area api-modules-images: ids ascending; areas.ts says what belongs here.
import type { Mutation } from '../mutate';

export const API_MODULES_IMAGES: readonly Mutation[] = [
  {
    id: 'image-proxy-checks-one-record',
    why: 'a name with one public record and one private one is let through to the private one',
    file: 'apps/api/src/modules/images/fetch-external.ts',
    find: 'addresses.some((entry) => !allowed(entry.address))',
    replace: 'addresses.every((entry) => !allowed(entry.address))',
    tests: ['apps/api/src/modules/images/fetch-external.integration.test.ts'],
  },
  {
    id: 'image-proxy-reuses-connections',
    why: 'a kept-alive socket skips the address check, and a rebinding name reaches the internal network',
    file: 'apps/api/src/modules/images/fetch-external.ts',
    find: "        method: 'GET',\n        lookup: options.lookup,\n        agent: false,\n",
    replace: "        method: 'GET',\n        lookup: options.lookup,\n",
    tests: ['apps/api/src/modules/images/fetch-external.integration.test.ts'],
  },
  {
    id: 'image-proxy-takes-literals',
    why: "an address literal skips the resolver's check and reaches whatever it names",
    file: 'apps/api/src/modules/images/proxy.ts',
    find: '    !literal &&\n',
    replace: '',
    tests: ['apps/api/src/modules/images/proxy.test.ts'],
  },
  {
    id: 'image-proxy-unbounded',
    why: 'an external image of any size is read whole into memory',
    file: 'apps/api/src/modules/images/fetch-external.ts',
    find: '          if (size > options.maxBytes) {\n',
    replace: '          if (size < 0) {\n',
    tests: ['apps/api/src/modules/images/fetch-external.integration.test.ts'],
  },
  {
    id: 'link-local-is-public',
    why: "the cloud's metadata service at 169.254.169.254 is a public address",
    file: 'apps/api/src/modules/images/addresses.ts',
    find: "  ['169.254.0.0', 16],\n",
    replace: '',
    tests: ['apps/api/src/modules/images/addresses.test.ts'],
  },
  {
    id: 'proxy-decodes-take-every-slot',
    why: 'the image proxy decodes in the node’s line without a share of its own, and a feed of pictures keeps an upload waiting',
    file: 'apps/api/src/modules/images/proxy.ts',
    find: 'await decoding(async () => await readImage(fetched.bytes, open))',
    replace: 'await readImage(fetched.bytes, open)',
    tests: ['apps/api/src/modules/images/proxy.test.ts'],
  },
];
