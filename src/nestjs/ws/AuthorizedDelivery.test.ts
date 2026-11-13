import { AuthorizedDelivery } from './AuthorizedDelivery';
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
describe('authorized delivery', () => {
  afterEach(() => jest.useRealTimers());
  test('preserves order and rechecks each event', async () => {
    const send = jest.fn(); const check = jest.fn().mockResolvedValue(true);
    const delivery = new AuthorizedDelivery(check, send, jest.fn());
    delivery.enqueue('first'); delivery.enqueue('second');
    await flush();
    expect(send.mock.calls.map((call) => call[0])).toEqual(['first', 'second']);
    expect(check).toHaveBeenCalledTimes(2); delivery.dispose();
  });
  test('does not deliver after authorization is revoked', async () => {
    const send = jest.fn(); const close = jest.fn();
    const check = jest.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const delivery = new AuthorizedDelivery(check, send, close);
    delivery.enqueue('first'); delivery.enqueue('second'); await flush();
    expect(send.mock.calls.map((call) => call[0])).toEqual(['first']);
    expect(close).toHaveBeenCalledTimes(1);
    delivery.enqueue('third'); await flush(); expect(send).toHaveBeenCalledTimes(1);
  });
  test('revalidates an idle connection', async () => {
    jest.useFakeTimers(); const close = jest.fn();
    const delivery = new AuthorizedDelivery(async () => false, jest.fn(), close);
    jest.advanceTimersByTime(5000); await flush();
    expect(close).toHaveBeenCalledWith('Authorization expired'); delivery.dispose();
  });
  test('bounds authorization wait and queued events', async () => {
    jest.useFakeTimers(); const close = jest.fn(); const send = jest.fn();
    const delivery = new AuthorizedDelivery(() => new Promise(() => {}), send, close);
    delivery.enqueue('first'); jest.advanceTimersByTime(2000); await flush();
    expect(close).toHaveBeenCalledTimes(1); expect(send).not.toHaveBeenCalled();
    delivery.dispose();
  });
});
