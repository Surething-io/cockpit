import { describe, expect, it } from 'vitest';
import { buildProjectUrl } from './projectUrl';

describe('buildProjectUrl', () => {
  it('carries a selected session into the project frame', () => {
    expect(buildProjectUrl('/work/a b', { sessionId: 'session/1', switchToAgent: true }))
      .toBe('/project?cwd=%2Fwork%2Fa%20b&sessionId=session%2F1&view=agent');
  });

  it('distinguishes a blank active tab from an unspecified active tab', () => {
    expect(buildProjectUrl('/work/project', { blank: true }))
      .toBe('/project?cwd=%2Fwork%2Fproject&newChat=1');
    expect(buildProjectUrl('/work/project'))
      .toBe('/project?cwd=%2Fwork%2Fproject');
  });
});
