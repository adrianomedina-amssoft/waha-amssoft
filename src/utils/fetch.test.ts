import { fetchBuffer } from './fetch';

describe('media origin policy', () => {
  const before = { ...process.env };
  afterEach(() => {
    for (const key of ['AMSSOFT_STATUS_ONLY', 'WAHA_MEDIA_ALLOWED_HOSTS']) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  });
  test('Status-only mode refuses URL media before network access', async () => {
    process.env.AMSSOFT_STATUS_ONLY = 'true';
    await expect(fetchBuffer('https://media.example/video.mp4')).rejects.toThrow('disabled');
  });
  test.each(['http://media.example/a', 'https://127.0.0.1/a', 'https://media.example:8443/a', 'https://user:secret@media.example/a', 'https://other.example/a'])('rejects unauthorized origin %s', async (url) => {
    process.env.AMSSOFT_STATUS_ONLY = 'false';
    process.env.WAHA_MEDIA_ALLOWED_HOSTS = 'media.example';
    await expect(fetchBuffer(url)).rejects.toThrow('not permitted');
  });
  test('missing allowlist is denied', async () => {
    process.env.AMSSOFT_STATUS_ONLY = 'false';
    delete process.env.WAHA_MEDIA_ALLOWED_HOSTS;
    await expect(fetchBuffer('https://media.example/a')).rejects.toThrow('not permitted');
  });
});
