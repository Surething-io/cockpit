import { describe, expect, it } from 'vitest';
import { delegatedOriginLine, parseMessageOrigin, sentOriginLine } from './messageOrigin';

const link = '/project?cwd=%2FUsers%2Fme%2Fapp&sessionId=s1&view=agent';

describe('parseMessageOrigin', () => {
  it('reads back what an @-mention writes, leaving only the message', () => {
    expect(parseMessageOrigin(`${sentOriginLine(link, 'app')}\n\n看一下进展呢`)).toEqual({
      kind: 'sent', link, project: 'app', body: '看一下进展呢',
    });
    expect(parseMessageOrigin(`${sentOriginLine(null, '')}\n\nhi\nthere`)).toEqual({
      kind: 'sent', link: null, project: null, body: 'hi\nthere',
    });
  });

  it('carries the input id that identifies one sent message', () => {
    expect(parseMessageOrigin(`${sentOriginLine(link, 'app', 'in-1')}\n\nhi`)).toEqual({
      kind: 'sent', link, project: 'app', body: 'hi', inputId: 'in-1',
    });
    expect(parseMessageOrigin(`${sentOriginLine(null, '', 'in-2')}\n\nhi`)).toMatchObject({ link: null, inputId: 'in-2' });
  });

  it('reads back a delegation, keeping its Task: title line', () => {
    expect(parseMessageOrigin(`Task: Port X\n${delegatedOriginLine(link, 'parent proj')}\n\nRead the brief`)).toEqual({
      kind: 'delegated', link, project: 'parent proj', body: 'Task: Port X\n\nRead the brief',
    });
  });

  it('leaves ordinary messages alone, including ones that merely quote the format later on', () => {
    expect(parseMessageOrigin('hello')).toBeNull();
    expect(parseMessageOrigin(`a\nb\n${sentOriginLine(link, 'app')}`)).toBeNull();
    expect(parseMessageOrigin(`a\nb\n${delegatedOriginLine(link, 'app')}`)).toBeNull();
  });
});
