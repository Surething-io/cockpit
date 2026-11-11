import { describe, expect, it } from 'vitest';
import { splitDecisionContext, stripDecisionContext } from './decisionContext';

/** Exactly what decision mode wrote into transcripts while it existed. */
const OLD_BLOCK = `<cockpit-decisions>
Earlier decisions in this project and the conditions they rest on. Background only: if the user's request below conflicts with one, point out the conflict and the affected premise and let the user decide — do not silently follow either side.
- [dec-mwbtn5t9-eceba7e5 r1794383562285] Keep candidates in an inbox. Holds while: candidates exist.
</cockpit-decisions>

`;

describe('old decision-mode context in transcripts', () => {
  it('splits the block from the user text', () => {
    const s = splitDecisionContext(`${OLD_BLOCK}fix the list titles`);
    expect(s.body).toBe('fix the list titles');
    expect(s.items).toEqual([{ key: 'dec-mwbtn5t9-eceba7e5@1794383562285', text: 'Keep candidates in an inbox. Holds while: candidates exist.' }]);
  });

  it('a message without a block, or with one later in the text, is left alone', () => {
    expect(splitDecisionContext('hello')).toEqual({ items: [], body: 'hello' });
    const quoted = 'look at this: <cockpit-decisions>x</cockpit-decisions>';
    expect(stripDecisionContext(quoted)).toBe(quoted);
  });

  it('titles and previews never show it', async () => {
    const { filterCommandTags: titleFilter } = await import('../server/sessionTitle');
    const { filterCommandTags: previewFilter } = await import('../server/transcriptViews');
    expect(titleFilter(`${OLD_BLOCK}fix the send path`)).toBe('fix the send path');
    expect(previewFilter(`${OLD_BLOCK}fix the send path`)).toBe('fix the send path');
  });
});
