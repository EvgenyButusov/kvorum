import { dynamic as daoDirectoryRendering } from './(shell)/daos/page';
import { dynamic as homeRendering } from './(shell)/page';

describe('runtime-backed public pages', () => {
  it('does not prerender API-backed pages into the build artifact', () => {
    expect(homeRendering).toBe('force-dynamic');
    expect(daoDirectoryRendering).toBe('force-dynamic');
  });
});
