import { SessionService } from './SessionService';
describe('legacy session startup', () => {
  function fixture(exists: boolean) {
    const manager = {
      withLock: jest.fn((name, action) => action()), exists: jest.fn().mockResolvedValue(exists),
      upsert: jest.fn(), assign: jest.fn(), start: jest.fn().mockResolvedValue({ name: 'dummy' }),
    };
    return { manager: manager, service: new SessionService(manager as any, {} as any) };
  }
  test('cannot create an absent session through legacy startup', async () => {
    const { manager, service } = fixture(false);
    await expect(service.upsertAndStartSession('dummy', {})).rejects.toThrow('Create the session');
    expect(manager.upsert).not.toHaveBeenCalled(); expect(manager.start).not.toHaveBeenCalled();
  });
  test('existing session is checked and updated inside the same lock', async () => {
    const { manager, service } = fixture(true);
    await expect(service.upsertAndStartSession('dummy', {})).resolves.toEqual({ name: 'dummy' });
    expect(manager.withLock).toHaveBeenCalledTimes(1);
    expect(manager.exists).toHaveBeenCalledWith('dummy'); expect(manager.start).toHaveBeenCalledWith('dummy');
  });
});
