import 'reflect-metadata';
import { SessionsController } from './sessions.controller';
import { CHECK_POLICIES_KEY } from '@waha/core/auth/policies.decorator';
import { CaslAbilityFactory } from '@waha/core/auth/casl.ability';
function allowed(method: string, actions: any, body: any) {
  const ability = new CaslAbilityFactory().createForUser({ isAdmin: false, session: 'dummy', actions: actions });
  const rules = Reflect.getMetadata(CHECK_POLICIES_KEY, SessionsController.prototype[method]);
  const context = { switchToHttp: () => ({ getRequest: () => ({ body: body }) }) };
  return rules.every((rule) => rule(ability, context));
}
describe('legacy permissions', () => {
  test('control alone can stop but cannot delete', () => {
    const actions = { control: true };
    expect(allowed('DEPRECATED_stop', actions, { name: 'dummy', logout: false })).toBe(true);
    expect(allowed('DEPRECATED_stop', actions, { name: 'dummy', logout: true })).toBe(false);
    expect(allowed('DEPRECATED_logout', actions, { name: 'dummy' })).toBe(false);
  });
  test('legacy configuration also requires setting authority', () => {
    expect(allowed('DEPRACATED_start', { control: true }, { name: 'dummy' })).toBe(false);
    expect(allowed('DEPRACATED_start', { control: true, setting: true }, { name: 'dummy' })).toBe(true);
  });
  test('delete permission stays scoped to its session', () => {
    expect(allowed('DEPRECATED_logout', { control: true, delete: true }, { name: 'other' })).toBe(false);
    expect(allowed('DEPRECATED_logout', { control: true, delete: true }, { name: 'dummy' })).toBe(true);
  });
});

describe('legacy input validation', () => {
  test('rejects a textual logout flag', async () => {
    const { WAHAValidationPipe } = await import('@waha/nestjs/pipes/WAHAValidationPipe');
    const { SessionStopDeprecatedRequest } = await import('@waha/structures/sessions.deprecated.dto');
    const pipe = new WAHAValidationPipe();
    await expect(pipe.transform({ name: 'dummy', logout: 'false' }, {
      type: 'body', metatype: SessionStopDeprecatedRequest,
    })).rejects.toThrow();
  });
});
