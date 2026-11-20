import axios from 'axios';
import { fetchBuffer } from './fetch';
const mockResolve4 = jest.fn();
const mockCancel = jest.fn();
jest.mock('dns/promises', () => ({ Resolver: jest.fn().mockImplementation(() => ({ resolve4: mockResolve4, cancel: mockCancel })) }));
jest.mock('axios', () => ({ __esModule: true, default: { get: jest.fn() } }));
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
describe('overall media deadline', () => {
  beforeEach(() => {
    jest.useFakeTimers(); jest.clearAllMocks();
    process.env.AMSSOFT_STATUS_ONLY = 'false';
    process.env.WAHA_MEDIA_ALLOWED_HOSTS = 'media.example';
  });
  afterEach(() => {
    jest.useRealTimers(); delete process.env.AMSSOFT_STATUS_ONLY;
    delete process.env.WAHA_MEDIA_ALLOWED_HOSTS;
  });
  test('cancels pending DNS at the global deadline', async () => {
    mockResolve4.mockReturnValue(new Promise(() => {}));
    const result = fetchBuffer('https://media.example/video.mp4').catch((error) => error);
    jest.advanceTimersByTime(15000); await flush();
    expect((await result).message).toContain('deadline');
    expect(mockCancel).toHaveBeenCalled(); expect(axios.get).not.toHaveBeenCalled();
  });
  test('HTTP receives only the remaining overall time', async () => {
    let release: (addresses: string[]) => void;
    mockResolve4.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    (axios.get as jest.Mock).mockReturnValue(new Promise(() => {}));
    const result = fetchBuffer('https://media.example/video.mp4').catch((error) => error);
    jest.advanceTimersByTime(10000); release(['8.8.8.8']); await flush();
    expect(axios.get).toHaveBeenCalledTimes(1);
    const signal = (axios.get as jest.Mock).mock.calls[0][1].signal;
    expect(signal.aborted).toBe(false);
    jest.advanceTimersByTime(5000); await flush();
    expect((await result).message).toContain('deadline'); expect(signal.aborted).toBe(true);
  });
  test.each(['10.0.0.1','100.64.0.1','127.0.0.1','169.254.1.1','172.16.0.1','192.168.0.1','224.0.0.1'])('rejects DNS destination %s', async (address) => {
    mockResolve4.mockResolvedValue([address]);
    await expect(fetchBuffer('https://media.example/a')).rejects.toThrow('DNS destination');
    expect(axios.get).not.toHaveBeenCalled(); expect(jest.getTimerCount()).toBe(0);
  });
});
